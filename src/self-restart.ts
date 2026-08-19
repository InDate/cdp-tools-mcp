/**
 * Ask the mcp-supervisor process managing this server to restart it - the
 * same mechanism `npm run build`'s postbuild hook and a manual
 * `kill -USR2 $(cat .devharness/mcp-supervisor.pid)` use (see
 * src/mcp-supervisor.ts). Only works when this server is running as the
 * supervisor's child, which is the default for both this repo's .mcp.json
 * and the package's published npx bin entry - a bare `node build/index.js`
 * has no pidfile to signal.
 *
 * The pidfile holds every live supervisor for this project root, so the
 * signal goes to the one supervising THIS process (its parent), not to
 * whichever wrote the file last: a checkout's supervisor and the
 * npx-installed one share the root, and signalling the wrong one restarts
 * another session while this one keeps its old code.
 *
 * Deps are injectable (rather than calling fs/process directly) so this is
 * unit-testable without touching the real filesystem or process table -
 * same rationale as RestartCoordinator in supervisor/restart-coordinator.ts.
 */
import { readFile } from 'fs/promises';
import { dirname } from 'path';
import { getOutputPath } from './helpers/paths.js';
import { parseSupervisorRecords, type SupervisorRecord } from './supervisor/pidfile.js';

export interface SelfRestartResult {
  ok: boolean;
  pid?: number;
  reason?: 'not-supervised' | 'stale-pid' | 'foreign-supervisor';
  /** foreign-supervisor: the pids that hold this root and serve another tree. */
  otherPids?: number[];
  error?: string;
}

export interface SelfRestartDeps {
  readPidFile: (path: string) => Promise<string>;
  sendSignal: (pid: number, signal: NodeJS.Signals) => void;
  ownParentPid: () => number;
  ownServerDir: () => string;
}

const defaultDeps: SelfRestartDeps = {
  readPidFile: (path) => readFile(path, 'utf-8'),
  sendSignal: (pid, signal) => process.kill(pid, signal),
  ownParentPid: () => process.ppid,
  ownServerDir: () => dirname(process.argv[1] ?? ''),
};

/**
 * The supervisor serving this process, in descending order of certainty:
 * the parent pid; the sole record built from the same directory as this
 * server; a lone pre-multi-record entry, which names a pid and nothing else.
 */
function selectOwnSupervisor(records: SupervisorRecord[], deps: SelfRestartDeps): SupervisorRecord | null {
  const parent = records.find(record => record.pid === deps.ownParentPid());
  if (parent) return parent;

  const sameTree = records.filter(record => record.script && dirname(record.script) === deps.ownServerDir());
  if (sameTree.length === 1) return sameTree[0];

  if (records.length === 1 && records[0].script === null) return records[0];

  return null;
}

export async function requestSelfRestart(deps: SelfRestartDeps = defaultDeps): Promise<SelfRestartResult> {
  const pidFilePath = getOutputPath('mcp-supervisor.pid');

  let raw: string;
  try {
    raw = await deps.readPidFile(pidFilePath);
  } catch {
    return { ok: false, reason: 'not-supervised' };
  }

  const records = parseSupervisorRecords(raw);
  if (records.length === 0) {
    return { ok: false, reason: 'not-supervised' };
  }

  const own = selectOwnSupervisor(records, deps);
  if (!own) {
    return { ok: false, reason: 'foreign-supervisor', otherPids: records.map(record => record.pid) };
  }

  try {
    deps.sendSignal(own.pid, 'SIGUSR2');
  } catch (error) {
    return { ok: false, pid: own.pid, reason: 'stale-pid', error: error instanceof Error ? error.message : String(error) };
  }

  return { ok: true, pid: own.pid };
}
