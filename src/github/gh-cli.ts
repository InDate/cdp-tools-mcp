/**
 * The `gh` CLI as a bounded subprocess.
 *
 * Every call is time-boxed and every failure is a typed code. Bug 003 is the
 * precedent: an unbounded wait blocked an autonomous agent for 25 minutes and
 * destroyed its report. A clear immediate error is fine; a hang is not.
 */

import { spawn as nodeSpawn, type SpawnOptions, type ChildProcess } from 'child_process';
import { getProjectDir } from '../helpers/paths.js';

export type GhFailureCode =
  | 'GH_NOT_INSTALLED'
  | 'GH_NOT_AUTHENTICATED'
  | 'GH_NO_REPO'
  | 'GH_TIMEOUT'
  | 'GH_FAILED';

export class GhError extends Error {
  readonly name = 'GhError';
  constructor(
    readonly code: GhFailureCode,
    message: string,
    readonly stderr: string = '',
    readonly args: string[] = []
  ) {
    super(message);
  }
}

export const DEFAULT_GH_TIMEOUT_MS = 20_000;
/** Grace between SIGTERM and SIGKILL. The promise has already rejected. */
const KILL_GRACE_MS = 2_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

let spawnImpl: SpawnFn = nodeSpawn as SpawnFn;

/** Test seam - pass null to restore the real spawn. */
export function setGhSpawnForTests(fn: SpawnFn | null): void {
  spawnImpl = fn ?? (nodeSpawn as SpawnFn);
}

export interface RunGhOptions {
  timeoutMs?: number;
  cwd?: string;
  /** Written to stdin, which is then closed. Closed regardless. */
  stdin?: string;
  signal?: AbortSignal;
}

function classify(stderr: string, args: string[]): GhError {
  if (/gh auth login|not logged (in|into)|authentication token|HTTP 401/i.test(stderr)) {
    return new GhError('GH_NOT_AUTHENTICATED', 'Not authenticated with GitHub', stderr, args);
  }
  if (/none of the git remotes|not a git repository|could not determine.*repository|no git remotes/i.test(stderr)) {
    return new GhError('GH_NO_REPO', 'No GitHub repository for this directory', stderr, args);
  }
  return new GhError('GH_FAILED', `gh ${args[0] ?? ''} failed`, stderr, args);
}

/**
 * Run `gh` and resolve its stdout.
 *
 * stdin is closed immediately and unconditionally: a `gh` that decides to
 * prompt then reads EOF and exits, instead of waiting forever on a pipe
 * nobody will write to. The env vars kill the other hang vectors - a pager
 * attached to a pipe, and the update-check network call.
 */
export function runGh(args: string[], opts: RunGhOptions = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_GH_TIMEOUT_MS;

  return new Promise<string>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnImpl('gh', args, {
        cwd: opts.cwd ?? getProjectDir(),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GH_PROMPT_DISABLED: '1',
          GH_NO_UPDATE_NOTIFIER: '1',
          GH_PAGER: 'cat',
          PAGER: 'cat',
          NO_COLOR: '1',
          CLICOLOR: '0',
        },
      });
    } catch (err) {
      reject(new GhError('GH_FAILED', `Could not start gh: ${(err as Error).message}`, '', args));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', onAbort);
    };

    /** Reject now; escalate to SIGKILL in the background. We never wait on it. */
    const abandon = (err: GhError) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
      killTimer.unref?.();
      reject(err);
    };

    const timer = setTimeout(() => {
      abandon(new GhError(
        'GH_TIMEOUT',
        `gh ${args[0] ?? ''} exceeded ${Math.round(timeoutMs / 1000)}s and was cancelled`,
        stderr,
        args
      ));
    }, timeoutMs);

    const onAbort = () => abandon(new GhError('GH_FAILED', 'Cancelled', stderr, args));
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    // Before any await point, so a prompting gh always sees EOF.
    if (opts.stdin) child.stdin?.write(opts.stdin);
    child.stdin?.end();

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
      if (stdout.length > MAX_OUTPUT_BYTES) {
        abandon(new GhError('GH_FAILED', 'gh produced more output than expected', stderr, args));
      }
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
      if (stderr.length > MAX_OUTPUT_BYTES) stderr = stderr.slice(0, MAX_OUTPUT_BYTES);
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err.code === 'ENOENT'
        ? new GhError('GH_NOT_INSTALLED', 'The gh CLI is not installed or not on PATH', '', args)
        : new GhError('GH_FAILED', `Could not run gh: ${err.message}`, stderr, args));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code === 0) resolve(stdout);
      else reject(classify(stderr, args));
    });
  });
}

export async function runGhJson<T>(args: string[], opts: RunGhOptions = {}): Promise<T> {
  const stdout = await runGh(args, opts);
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new GhError('GH_FAILED', `gh ${args[0] ?? ''} returned output that is not JSON`, stdout.slice(0, 500), args);
  }
}

/** Truncated stderr for a user-facing message. */
export function ghDetail(err: GhError, limit = 500): string {
  const text = (err.stderr || err.message).trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
