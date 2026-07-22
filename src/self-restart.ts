/**
 * Ask the mcp-supervisor process managing this server to restart it - the
 * same mechanism `npm run build`'s postbuild hook and a manual
 * `kill -USR2 $(cat .cdp-tools/mcp-supervisor.pid)` use (see
 * src/mcp-supervisor.ts). Only works when this server is running as the
 * supervisor's child, which is the default for both this repo's .mcp.json
 * and the package's published npx bin entry - a bare `node build/index.js`
 * has no pidfile to signal.
 *
 * Deps are injectable (rather than calling fs/process directly) so this is
 * unit-testable without touching the real filesystem or process table -
 * same rationale as RestartCoordinator in supervisor/restart-coordinator.ts.
 */
import { readFile } from 'fs/promises';
import { getOutputPath } from './helpers/paths.js';

export interface SelfRestartResult {
  ok: boolean;
  pid?: number;
  reason?: 'not-supervised' | 'stale-pid';
  error?: string;
}

export interface SelfRestartDeps {
  readPidFile: (path: string) => Promise<string>;
  sendSignal: (pid: number, signal: NodeJS.Signals) => void;
}

const defaultDeps: SelfRestartDeps = {
  readPidFile: (path) => readFile(path, 'utf-8'),
  sendSignal: (pid, signal) => process.kill(pid, signal),
};

export async function requestSelfRestart(deps: SelfRestartDeps = defaultDeps): Promise<SelfRestartResult> {
  const pidFilePath = getOutputPath('mcp-supervisor.pid');

  let raw: string;
  try {
    raw = await deps.readPidFile(pidFilePath);
  } catch {
    return { ok: false, reason: 'not-supervised' };
  }

  const pid = parseInt(raw.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, reason: 'not-supervised' };
  }

  try {
    deps.sendSignal(pid, 'SIGUSR2');
  } catch (error) {
    return { ok: false, pid, reason: 'stale-pid', error: error instanceof Error ? error.message : String(error) };
  }

  return { ok: true, pid };
}
