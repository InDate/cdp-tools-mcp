/**
 * Watches the MCP client (Claude Code, the Claude desktop app, an IDE) that
 * this supervisor was launched to serve, and reports when it is gone.
 *
 * WHY THIS EXISTS
 * The supervisor already shuts down on stdin end/close, which is supposed to
 * catch a client that dies without signalling. It does not fire when the
 * client was launched through `npx`: the `npm exec` wrapper sits between the
 * client and this process, survives the client's death (reparented to init),
 * and keeps holding the write end of our stdin pipe. No EOF ever arrives, so
 * the whole tree - supervisor, real server, its Chrome and dev servers - lives
 * on for days holding memory nobody is asking it to hold (issue #138).
 *
 * So instead of waiting to be told, we find out who the client actually is and
 * check whether it is still alive.
 *
 * FINDING THE CLIENT
 * Walk up the process ancestry from this process and take the first ancestor
 * that isn't part of the launch plumbing - Node itself, npm/npx, a shell. For
 * the three shapes seen in the wild that lands on:
 *   node <- npm exec <- claude                          => claude
 *   node <- npm exec <- disclaimer <- Claude.app         => disclaimer (the
 *       Claude app's own helper - it dies with the app, which is what matters)
 *   node <- code helper                                  => the IDE helper
 *
 * If the walk finds nothing but plumbing all the way to pid 1, there is no
 * client to watch and reaping is disabled - better to leak than to kill a tree
 * that is still serving someone.
 */
import { execFileSync } from 'child_process';

export interface ProcessInfo {
  ppid: number;
  command: string;
}

export interface ProcessProbe {
  /** Parent pid + command for a pid, or null if the pid is gone/unreadable. */
  info(pid: number): ProcessInfo | null;
  /** Whether the pid still exists. */
  isAlive(pid: number): boolean;
}

export interface ClientIdentity {
  pid: number;
  command: string;
}

/**
 * Package managers and shells that are only ever launch plumbing, never the
 * client itself. Matched against the command's leading token's basename.
 */
const PLUMBING = new Set([
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'bunx',
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'env',
  'exec',
  'login',
]);

/** Runtimes that are plumbing or client depending on what they are running. */
const RUNTIMES = new Set(['node', 'node.exe', 'nodejs', 'bun', 'deno']);

/**
 * Scripts that mean a runtime process is npm/npx machinery rather than the
 * client. Anything else a runtime is running is treated as the client itself:
 * an npm-installed MCP host appears in `ps` as `node .../cli.js`, and calling
 * every node process plumbing would walk straight past it to the user's shell
 * and terminal - which live for weeks, so the tree would never be reaped.
 */
const RUNTIME_PLUMBING_SCRIPTS = [
  'npm-cli.js',
  'npx-cli.js',
  'npm-prefix.js',
  '/node_modules/.bin/',
  '/npm/bin/',
  '/_npx/',
  '/corepack/',
];

function isPlumbing(command: string): boolean {
  const tokens = command.trim().split(/\s+/);
  const basename = (tokens[0] ?? '').split('/').pop() ?? '';

  if (PLUMBING.has(basename)) return true;

  if (RUNTIMES.has(basename)) {
    // A bare runtime with no script (a REPL, or an unreadable command) tells
    // us nothing; treat it as plumbing, as before.
    const script = tokens.slice(1).find((token) => !token.startsWith('-'));
    if (!script) return true;
    return RUNTIME_PLUMBING_SCRIPTS.some((marker) => script.includes(marker));
  }

  return false;
}

/** Reads process info via `ps`. Unavailable on Windows, which has no `ps`. */
export const systemProcessProbe: ProcessProbe = {
  info(pid: number): ProcessInfo | null {
    try {
      const out = execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], {
        encoding: 'utf-8',
        timeout: 2000,
      }).trim();
      if (!out) return null;
      const match = out.match(/^\s*(\d+)\s+(.*)$/);
      if (!match) return null;
      return { ppid: Number(match[1]), command: match[2] };
    } catch {
      return null;
    }
  },
  isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM means it exists but belongs to another user - still alive.
      return (err as NodeJS.ErrnoException)?.code === 'EPERM';
    }
  },
};

/**
 * Walk up from `startPid`'s parent and return the first ancestor that isn't
 * launch plumbing, or null if there is none.
 */
export function resolveClientIdentity(
  startPid: number,
  probe: ProcessProbe,
  maxDepth = 12
): ClientIdentity | null {
  let current = probe.info(startPid);
  for (let depth = 0; depth < maxDepth; depth++) {
    if (!current || current.ppid <= 1) return null;
    const parent = probe.info(current.ppid);
    if (!parent) return null;
    if (!isPlumbing(parent.command)) {
      return { pid: current.ppid, command: parent.command };
    }
    current = { ppid: parent.ppid, command: parent.command };
  }
  return null;
}

export interface ClientWatcherOptions {
  /** How often to check the client is still alive (default: 60s). */
  pollIntervalMs?: number;
  probe?: ProcessProbe;
  logStderr?: (message: string) => void;
}

/**
 * Polls the resolved client's liveness and calls back once, when it dies.
 * Does nothing at all when no client could be resolved.
 */
export class ClientWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly probe: ProcessProbe;
  private readonly pollIntervalMs: number;
  private readonly logStderr: (message: string) => void;
  private client: ClientIdentity | null = null;

  constructor(private readonly options: ClientWatcherOptions = {}) {
    this.probe = options.probe ?? systemProcessProbe;
    this.pollIntervalMs = options.pollIntervalMs ?? 60_000;
    this.logStderr = options.logStderr ?? (() => {});
  }

  getClient(): ClientIdentity | null {
    return this.client;
  }

  /**
   * Resolve the client and start watching. Returns the client it will watch,
   * or null if none could be resolved (in which case nothing is watched).
   */
  start(startPid: number, onClientGone: (client: ClientIdentity) => void): ClientIdentity | null {
    if (process.platform === 'win32') {
      this.logStderr('Client watcher disabled on Windows (no ps); relying on stdin close');
      return null;
    }

    this.client = resolveClientIdentity(startPid, this.probe);
    if (!this.client) {
      this.logStderr('Could not identify the MCP client process; orphan reaping disabled');
      return null;
    }

    const client = this.client;
    this.logStderr(`Watching client PID ${client.pid} (${client.command.slice(0, 80)})`);

    this.timer = setInterval(() => {
      if (this.probe.isAlive(client.pid)) return;
      this.stop();
      this.logStderr(`Client PID ${client.pid} is gone; shutting down`);
      onClientGone(client);
    }, this.pollIntervalMs);
    this.timer.unref?.();

    return client;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
