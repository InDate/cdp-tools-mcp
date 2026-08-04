/**
 * Ownership claims for managed dev servers.
 *
 * WHY THIS EXISTS
 * `servers.json` records no owner, and every session in a directory reattaches
 * to the same running servers, so no session could tell its own dev server
 * from someone else's. That left two failures with one cause (issue #139):
 * a window closed for good left its dev servers running until reboot, and an
 * idle suspend could not release dev servers at all, because stopping one
 * might pull it out from under another window still using it.
 *
 * WHAT A CLAIM IS
 * One file per claim, named `<serverId>--<supervisorPid>.json`. A claim is
 * valid exactly while its `supervisorPid` names a live process. The supervisor
 * is the right anchor because it is the only process whose lifetime IS the
 * session's: it survives the child dying on suspend and on every rebuild
 * restart, and it dies when the client does (see supervisor/client-watcher.ts).
 * A claim held by the MCP child instead would evaporate during a two-second
 * rebuild, and another session suspending in that window would stop a server
 * that is very much in use.
 *
 * WHY A DIRECTORY RATHER THAN ONE FILE
 * Each file has exactly one writer, ever - the session named in its own
 * filename. Creating is an atomic temp+rename, releasing is an unlink, and
 * nothing anywhere does read-modify-write, so concurrent sessions cannot race.
 * (`servers.json` itself is not safe this way: ServerManager's save mutex is
 * per-process, so two sessions writing it can still lose an update. Putting
 * owner fields in there would inherit that.)
 *
 * PRESENCE, NOT JUST CLAIMS
 * A claim is taken when a session starts a server or reattaches to one at
 * startup. That alone is not enough: a window already open when another window
 * starts a dev server never gets to claim it, and would then have it stopped
 * out from under it - the common ordering, not an edge case. So each session
 * also records its presence in a project directory, and a server is protected
 * while any other live session is working where it runs. That makes the rule
 * independent of who started what, and of the order things happened in.
 *
 * THE RULE THIS SUPPORTS
 * Stop a server only when no other LIVE session either claims it or is working
 * in its directory. Anything unknown - unreadable directory, unparseable
 * record, a liveness check that throws - counts as "someone might need it", so
 * the server is left alone. The costs are asymmetric: under-stopping leaks a
 * process until the next garbage collection, over-stopping destroys work that
 * was running.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, unlinkSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { atomicWriteFile } from './atomic-write.js';
import { getOutputPath } from './helpers/paths.js';
import { isProcessAlive } from './helpers/process-liveness.js';
import { debugLog } from './debug-logger.js';

const CLAIMS_DIR = 'server-claims';
const SESSIONS_DIR = 'sessions';

export interface ServerClaim {
  serverId: string;
  /** The claiming session's supervisor. Liveness of this pid IS the claim's validity. */
  supervisorPid: number;
  /** Start time of that supervisor, to survive pid reuse. Empty when unavailable. */
  supervisorStartedAt: string;
  /** Diagnostics only - which child process wrote the claim, and when. */
  childPid: number;
  cwd: string;
  createdAt: string;
}

/**
 * The supervisor that owns this session.
 *
 * The child is spawned directly by the supervisor (see supervisor/child-manager.ts),
 * so its parent is the right pid, captured once at startup: `process.ppid`
 * changes to 1 if the parent dies, which would silently reassign ownership.
 */
const OWN_SUPERVISOR_PID = process.ppid;

/**
 * When a pid started, as the OS reports it.
 *
 * A pid alone cannot survive reuse: a recycled pid makes a dead session look
 * alive, which pins its servers forever. Comparing start times distinguishes
 * "still the same process" from "some new process wearing its number".
 * Returns '' when it cannot be read, and callers treat that as "cannot
 * disprove" rather than as a mismatch.
 */
export function readProcessStartTime(pid: number): string {
  if (process.platform === 'win32') return '';
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: 2000,
    }).trim();
  } catch {
    return '';
  }
}

/**
 * A directory path in the one form everything compares against.
 *
 * On macOS the same directory is reachable as both `/tmp/x` and `/private/tmp/x`,
 * and a server's recorded cwd and a session's `process.cwd()` routinely
 * disagree about which - so a plain string comparison silently decides two
 * windows in the same project are in different ones, and stops a server that
 * is in use.
 */
function canonicalPath(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

export interface SessionPresence {
  supervisorPid: number;
  supervisorStartedAt: string;
  childPid: number;
  cwd: string;
  startedAt: string;
}

export interface ClaimsStoreOptions {
  /** Own supervisor pid; overridable for tests. */
  supervisorPid?: number;
  /** Reads a pid's start time; overridable for tests. */
  startTimeReader?: (pid: number) => string;
  /** Liveness check; overridable for tests. */
  isAlive?: (pid: number) => boolean;
}

/**
 * Reads and writes the claim files for one storage scope (local or global),
 * mirroring where `servers.json` itself lives so a claim always sits beside
 * the record it refers to.
 */
export class ServerClaimsStore {
  private readonly supervisorPid: number;
  private readonly readStartTime: (pid: number) => string;
  private readonly isAlive: (pid: number) => boolean;
  private readonly ownStartTime: string;

  constructor(options: ClaimsStoreOptions = {}) {
    this.supervisorPid = options.supervisorPid ?? OWN_SUPERVISOR_PID;
    this.readStartTime = options.startTimeReader ?? readProcessStartTime;
    this.isAlive = options.isAlive ?? isProcessAlive;
    this.ownStartTime = this.readStartTime(this.supervisorPid);
  }

  getOwnSupervisorPid(): number {
    return this.supervisorPid;
  }

  private dir(global: boolean): string {
    return getOutputPath(CLAIMS_DIR, { global });
  }

  private claimPath(serverId: string, global: boolean): string {
    return join(this.dir(global), `${encodeURIComponent(serverId)}--${this.supervisorPid}.json`);
  }

  /**
   * Every claim on disk for a scope, dead ones included. Anything unreadable or
   * unparseable is skipped rather than thrown: a corrupt claim must not be able
   * to break a shutdown path.
   */
  readAll(global: boolean): Array<{ path: string; claim: ServerClaim }> {
    const dir = this.dir(global);
    if (!existsSync(dir)) return [];

    const claims: Array<{ path: string; claim: ServerClaim }> = [];
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return [];
    }

    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const path = join(dir, entry);
      try {
        const claim = JSON.parse(readFileSync(path, 'utf-8')) as ServerClaim;
        if (typeof claim?.serverId === 'string' && Number.isInteger(claim?.supervisorPid)) {
          claims.push({ path, claim });
        }
      } catch {
        // Unreadable or corrupt - ignore it. It will be collected as dead only
        // if its filename says so; otherwise it is simply not counted.
      }
    }
    return claims;
  }

  /**
   * Whether a claim is still valid: its supervisor is alive, and (when both
   * start times are readable) it is the same process that made the claim
   * rather than a recycled pid.
   */
  isClaimLive(claim: ServerClaim): boolean {
    if (!this.isAlive(claim.supervisorPid)) return false;

    const currentStart = this.readStartTime(claim.supervisorPid);
    // Either side unreadable means we cannot disprove it - and an unprovable
    // claim must count as live, since the cost of being wrong the other way is
    // stopping a running server.
    if (!currentStart || !claim.supervisorStartedAt) return true;
    return currentStart === claim.supervisorStartedAt;
  }

  /** Record this session as an owner of `serverId`. Idempotent. */
  async claim(serverId: string, cwd: string, global: boolean): Promise<void> {
    const dir = this.dir(global);
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      const claim: ServerClaim = {
        serverId,
        supervisorPid: this.supervisorPid,
        supervisorStartedAt: this.ownStartTime,
        childPid: process.pid,
        cwd,
        createdAt: new Date().toISOString(),
      };
      await atomicWriteFile(this.claimPath(serverId, global), JSON.stringify(claim, null, 2));
    } catch (error) {
      // A server with no claim is unprotected against another session's
      // garbage collection, so this is worth being loud about even though it
      // must not fail the start itself.
      console.error(`[cdp-tools] Could not claim server "${serverId}": ${error}`);
      await debugLog('ServerClaims', `Failed to claim ${serverId}: ${error}`);
    }
  }

  /** Drop this session's claim on `serverId`, if it holds one. */
  release(serverId: string, global: boolean): void {
    try {
      const path = this.claimPath(serverId, global);
      if (existsSync(path)) unlinkSync(path);
    } catch (error) {
      void debugLog('ServerClaims', `Failed to release claim on ${serverId}: ${error}`);
    }
  }

  /** Drop every claim this session holds, across both scopes. */
  releaseAllOwn(): void {
    for (const global of [false, true]) {
      for (const { path, claim } of this.readAll(global)) {
        if (claim.supervisorPid !== this.supervisorPid) continue;
        try {
          unlinkSync(path);
        } catch {
          // Already gone, or not ours to remove.
        }
      }
    }
  }

  /**
   * Whether a live session OTHER than this one claims `serverId`.
   */
  hasForeignLiveClaim(serverId: string, global: boolean): boolean {
    return this.readAll(global).some(
      ({ claim }) =>
        claim.serverId === serverId &&
        claim.supervisorPid !== this.supervisorPid &&
        this.isClaimLive(claim)
    );
  }

  // ---------------------------------------------------------------- presence

  private sessionsDir(): string {
    // Always global: a session's presence is a fact about the machine, and the
    // sessions that need to see it may not share this one's project storage.
    return getOutputPath(SESSIONS_DIR, { global: true });
  }

  private sessionPath(supervisorPid: number): string {
    return join(this.sessionsDir(), `${supervisorPid}.json`);
  }

  /** Announce that this session is working in `cwd`. */
  async registerSession(cwd: string): Promise<void> {
    try {
      const dir = this.sessionsDir();
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      const presence: SessionPresence = {
        supervisorPid: this.supervisorPid,
        supervisorStartedAt: this.ownStartTime,
        childPid: process.pid,
        cwd: canonicalPath(cwd),
        startedAt: new Date().toISOString(),
      };
      await atomicWriteFile(this.sessionPath(this.supervisorPid), JSON.stringify(presence, null, 2));
    } catch (error) {
      // Losing our own presence record only risks another session collecting a
      // server we are using, so it is worth saying out loud.
      console.error(`[cdp-tools] Could not record session presence: ${error}`);
    }
  }

  /** Withdraw this session's presence record. */
  unregisterSession(): void {
    try {
      const path = this.sessionPath(this.supervisorPid);
      if (existsSync(path)) unlinkSync(path);
    } catch {
      // Already gone.
    }
  }

  /** Every presence record on disk, dead ones included. */
  readSessions(): Array<{ path: string; presence: SessionPresence }> {
    const dir = this.sessionsDir();
    if (!existsSync(dir)) return [];

    const sessions: Array<{ path: string; presence: SessionPresence }> = [];
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return [];
    }

    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const path = join(dir, entry);
      try {
        const presence = JSON.parse(readFileSync(path, 'utf-8')) as SessionPresence;
        if (Number.isInteger(presence?.supervisorPid) && typeof presence?.cwd === 'string') {
          sessions.push({ path, presence });
        }
      } catch {
        // Corrupt record - ignore.
      }
    }
    return sessions;
  }

  /**
   * Whether another live session is working in `cwd`.
   *
   * This is what makes the rule independent of ordering: a window that was
   * already open when someone else started a dev server never had a chance to
   * claim it, but it is plainly still using the project.
   */
  hasOtherLiveSessionIn(cwd: string): boolean {
    const target = canonicalPath(cwd);
    return this.readSessions().some(
      ({ presence }) =>
        presence.supervisorPid !== this.supervisorPid &&
        canonicalPath(presence.cwd) === target &&
        this.isPresenceLive(presence)
    );
  }

  private isPresenceLive(presence: SessionPresence): boolean {
    if (!this.isAlive(presence.supervisorPid)) return false;
    const currentStart = this.readStartTime(presence.supervisorPid);
    if (!currentStart || !presence.supervisorStartedAt) return true;
    return currentStart === presence.supervisorStartedAt;
  }

  /** Delete presence records whose session is gone. */
  collectDeadSessions(): number {
    let removed = 0;
    for (const { path, presence } of this.readSessions()) {
      if (this.isPresenceLive(presence)) continue;
      try {
        unlinkSync(path);
        removed++;
      } catch {
        // Someone else got there first.
      }
    }
    return removed;
  }

  /**
   * The whole decision, in one place: may this session stop `serverId`,
   * running out of `serverCwd`?
   */
  mayStop(serverId: string, serverCwd: string, global: boolean): boolean {
    if (this.hasForeignLiveClaim(serverId, global)) return false;
    if (this.hasOtherLiveSessionIn(serverCwd)) return false;
    return true;
  }

  /**
   * Delete claims whose owning session is gone, and report which servers were
   * left with no live claim at all - those are the ones nobody is coming back
   * for.
   */
  collectDeadClaims(global: boolean): { removed: number; unclaimedServerIds: string[] } {
    const all = this.readAll(global);
    let removed = 0;
    const liveByServer = new Map<string, number>();

    for (const { path, claim } of all) {
      if (this.isClaimLive(claim)) {
        liveByServer.set(claim.serverId, (liveByServer.get(claim.serverId) ?? 0) + 1);
        continue;
      }
      try {
        unlinkSync(path);
        removed++;
      } catch {
        // Someone else collected it first; fine either way.
      }
    }

    const unclaimedServerIds = [...new Set(all.map(({ claim }) => claim.serverId))].filter(
      (serverId) => !liveByServer.has(serverId)
    );

    return { removed, unclaimedServerIds };
  }
}

/** The store used by the running server. */
export const serverClaims = new ServerClaimsStore();
