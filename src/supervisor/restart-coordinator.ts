/**
 * The protocol-level restart state machine. Deliberately built against
 * injected functions rather than real streams/processes so it's unit
 * testable with plain spies (see restart-coordinator.test.ts).
 *
 * Responsibilities:
 * - Proxy host<->child JSON-RPC lines verbatim in steady state.
 * - Capture the first `initialize` request + `notifications/initialized`
 *   notification so they can be replayed to a freshly spawned child (a
 *   second `initialize` on a fresh process is harmless/idempotent per the
 *   MCP SDK - it has no "already initialized" guard - but the *response* to
 *   a replayed initialize must be swallowed, since the host already
 *   consumed its original response and isn't expecting a second one).
 * - Synthesize an error response for any request left dangling by a dying
 *   child (deliberate restart or crash), so the host never hangs waiting
 *   for an answer that will never arrive.
 * - Back off and eventually give up on repeated unplanned crashes.
 */
import { classifyLine, serializeMessage } from './ndjson-reader.js';

export type SupervisorPhase = 'ready' | 'restarting' | 'idle-gave-up';

export interface RestartCoordinatorDeps {
  writeToChild: (line: string) => void;
  writeToHost: (line: string) => void;
  killChild: () => Promise<void>;
  spawnChild: () => void;
  logStderr: (message: string) => void;
}

export interface RestartCoordinatorOptions {
  maxCrashAttempts?: number; // default 10
  crashBackoffBaseMs?: number; // default 500
  crashBackoffCapMs?: number; // default 30000
  stabilityThresholdMs?: number; // default 10000 - a child surviving this long resets the crash counter
}

const CONNECTION_CLOSED_ERROR_CODE = -32000; // matches the SDK's own ErrorCode.ConnectionClosed

export class RestartCoordinator {
  private phase: SupervisorPhase = 'ready';

  private hasSeenFirstInit = false;
  private initRequestLine: string | null = null;
  private initRequestId: string | number | null = null;
  private initializedLine: string | null = null;
  private awaitingReplayResponseId: string | number | null = null;
  // True once the host has received a real answer to its original `initialize`.
  // Only then do we swallow a *replayed* init's response on a later restart -
  // if a restart happens before the host ever got its first answer, the new
  // child's response must flow through normally instead, or the host would
  // hang forever waiting for a response we ate.
  private initAnswered = false;

  private inFlight = new Map<string | number, { method: string }>();
  private abandonedIds = new Set<string | number>();

  private expectingExit = false;
  private crashAttempt = 0;
  private crashBackoffTimer: ReturnType<typeof setTimeout> | null = null;
  private stabilityTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly maxCrashAttempts: number;
  private readonly crashBackoffBaseMs: number;
  private readonly crashBackoffCapMs: number;
  private readonly stabilityThresholdMs: number;

  constructor(private readonly deps: RestartCoordinatorDeps, options: RestartCoordinatorOptions = {}) {
    this.maxCrashAttempts = options.maxCrashAttempts ?? 10;
    this.crashBackoffBaseMs = options.crashBackoffBaseMs ?? 500;
    this.crashBackoffCapMs = options.crashBackoffCapMs ?? 30000;
    this.stabilityThresholdMs = options.stabilityThresholdMs ?? 10000;
  }

  getPhase(): SupervisorPhase {
    return this.phase;
  }

  /** A raw NDJSON line arrived from the host, headed for the child. */
  handleHostLine(line: string): void {
    const parsed = classifyLine(line);

    if (this.phase !== 'ready') {
      if (parsed.kind === 'request') {
        this.sendSynthesizedError(parsed.id);
      } else {
        this.deps.logStderr(`Dropping host ${parsed.kind} received while phase=${this.phase}`);
      }
      return;
    }

    let isCapturedInitRequest = false;
    if (!this.hasSeenFirstInit && parsed.kind === 'request' && parsed.method === 'initialize') {
      this.hasSeenFirstInit = true;
      this.initRequestLine = line;
      this.initRequestId = parsed.id;
      isCapturedInitRequest = true;
    } else if (
      this.initRequestLine &&
      !this.initializedLine &&
      parsed.kind === 'notification' &&
      parsed.method === 'notifications/initialized'
    ) {
      this.initializedLine = line;
    }

    // The captured init request's lifecycle is managed separately (via
    // initAnswered/awaitingReplayResponseId below), not the generic in-flight
    // map - otherwise a restart before its real answer arrives would
    // synthesize a premature error for it in addition to the eventual real
    // (or replayed) response, double-delivering to the host.
    if (parsed.kind === 'request' && !isCapturedInitRequest) {
      this.inFlight.set(parsed.id, { method: parsed.method });
    }

    this.deps.writeToChild(line);
  }

  /** A raw NDJSON line arrived from the (current) child, headed for the host. */
  handleChildLine(line: string): void {
    const parsed = classifyLine(line);

    if (parsed.kind === 'response') {
      if (this.awaitingReplayResponseId !== null && parsed.id === this.awaitingReplayResponseId) {
        this.awaitingReplayResponseId = null;
        return; // swallow - host already has the original initialize response
      }
      if (this.abandonedIds.has(parsed.id)) {
        this.abandonedIds.delete(parsed.id);
        return; // late response for an id we already answered synthetically
      }
      this.inFlight.delete(parsed.id);
      if (this.initRequestId !== null && parsed.id === this.initRequestId) {
        this.initAnswered = true;
      }
    }

    this.deps.writeToHost(line);
  }

  /** The current child's stdout stream closed - no more late responses possible from it. */
  onChildStdoutClosed(): void {
    this.abandonedIds.clear();
  }

  /**
   * Call before deliberately killing the child as part of supervisor shutdown
   * (not a restart - no respawn follows). Without this, the child's resulting
   * 'exit' event would be indistinguishable from a real crash.
   */
  prepareForShutdown(): void {
    this.expectingExit = true;
    if (this.crashBackoffTimer) {
      clearTimeout(this.crashBackoffTimer);
      this.crashBackoffTimer = null;
    }
    this.clearStabilityTimer();
  }

  /** The current child process exited (fires for both deliberate kills and crashes). */
  onChildExit(): void {
    if (this.expectingExit) {
      // requestRestart()'s own flow (awaiting killChild()) drives what happens next.
      return;
    }
    this.clearStabilityTimer();
    this.synthesizeErrorsForAllInFlight();
    this.crashAttempt++;

    if (this.crashAttempt > this.maxCrashAttempts) {
      this.phase = 'idle-gave-up';
      this.deps.logStderr(
        `Giving up after ${this.crashAttempt - 1} consecutive crashes; waiting for an explicit restart trigger.`
      );
      return;
    }

    const delay = Math.min(this.crashBackoffBaseMs * Math.pow(2, this.crashAttempt - 1), this.crashBackoffCapMs);
    this.phase = 'restarting';
    this.deps.logStderr(`Child crashed (attempt ${this.crashAttempt}/${this.maxCrashAttempts}), respawning in ${delay}ms`);
    this.crashBackoffTimer = setTimeout(() => {
      this.crashBackoffTimer = null;
      this.spawnAndReplay();
    }, delay);
  }

  /** Explicit restart trigger (SIGUSR2, wired to a postbuild hook or sent manually). */
  requestRestart(reason: string): void {
    if (this.phase === 'restarting') {
      this.deps.logStderr(`Restart already in progress, ignoring additional trigger (${reason})`);
      return;
    }
    if (this.phase === 'idle-gave-up') {
      this.crashAttempt = 0;
    }
    if (this.crashBackoffTimer) {
      clearTimeout(this.crashBackoffTimer);
      this.crashBackoffTimer = null;
    }
    this.clearStabilityTimer();

    this.phase = 'restarting';
    this.synthesizeErrorsForAllInFlight();
    this.expectingExit = true;

    this.deps
      .killChild()
      .catch((err) => this.deps.logStderr(`killChild() failed (continuing anyway): ${err}`))
      .then(() => {
        this.expectingExit = false;
        this.spawnAndReplay();
      });
  }

  private spawnAndReplay(): void {
    this.deps.spawnChild();

    if (this.initRequestLine && this.initRequestId !== null) {
      // Only swallow the replayed init's response if the host already has a
      // real answer from before - otherwise it's still waiting for its very
      // first one, so let this response flow through normally instead.
      if (this.initAnswered) {
        this.awaitingReplayResponseId = this.initRequestId;
      }
      this.deps.writeToChild(this.initRequestLine);
      if (this.initializedLine) {
        this.deps.writeToChild(this.initializedLine);
      }
    }

    this.phase = 'ready';
    this.stabilityTimer = setTimeout(() => {
      this.crashAttempt = 0;
    }, this.stabilityThresholdMs);

    // Best-effort: the host may have cached tool schemas from the original
    // initialize; if a rebuild changed one, this nudges a compliant host to
    // re-fetch. Only relevant once a real handshake has actually happened
    // (never fires for the very first startup spawn, which doesn't go
    // through this method at all).
    if (this.initRequestLine) {
      this.deps.writeToHost(serializeMessage({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }));
    }
  }

  private synthesizeErrorsForAllInFlight(): void {
    for (const id of this.inFlight.keys()) {
      this.abandonedIds.add(id);
      this.sendSynthesizedError(id);
    }
    this.inFlight.clear();
  }

  private sendSynthesizedError(id: string | number): void {
    this.deps.writeToHost(
      serializeMessage({
        jsonrpc: '2.0',
        id,
        error: {
          code: CONNECTION_CLOSED_ERROR_CODE,
          message: 'MCP server is restarting; this request will not receive a response from the previous process. Please retry.',
        },
      })
    );
  }

  private clearStabilityTimer(): void {
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = null;
    }
  }
}
