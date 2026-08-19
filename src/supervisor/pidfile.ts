import { promises as fs } from 'fs';
import { atomicWriteFile } from '../atomic-write.js';

/**
 * One supervisor holding this project root, and the script it runs.
 *
 * `script` is the tree a rebuild of that source reaches: two supervisors can
 * serve the same project directory at once - a checkout's own
 * `build/mcp-supervisor.js` and the npx-installed copy - and a rebuild here
 * changes the code of exactly one of them. `null` is a pidfile written by a
 * version that recorded a bare pid.
 */
export interface SupervisorRecord {
  pid: number;
  script: string | null;
}

/**
 * Parse pidfile contents. A bare integer is the pre-multi-record format and
 * reads as one record with no script.
 */
export function parseSupervisorRecords(contents: string): SupervisorRecord[] {
  const trimmed = contents.trim();
  if (trimmed.length === 0) return [];

  if (/^\d+$/.test(trimmed)) {
    const pid = parseInt(trimmed, 10);
    return pid > 0 ? [{ pid, script: null }] : [];
  }

  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  const entries = Array.isArray(parsed?.supervisors) ? parsed.supervisors : [];
  return entries
    .map((entry: any) => ({
      pid: typeof entry?.pid === 'number' ? entry.pid : parseInt(entry?.pid, 10),
      script: typeof entry?.script === 'string' ? entry.script : null,
    }))
    .filter((record: SupervisorRecord) => Number.isInteger(record.pid) && record.pid > 0);
}

export async function readSupervisorRecords(pidFilePath: string): Promise<SupervisorRecord[]> {
  try {
    return parseSupervisorRecords(await fs.readFile(pidFilePath, 'utf-8'));
  } catch {
    return [];
  }
}

function serialize(records: SupervisorRecord[]): string {
  return JSON.stringify({ supervisors: records }, null, 2);
}

const defaultIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
};

/**
 * Add this supervisor to the pidfile, keeping every other live one.
 *
 * A single-pid pidfile is last-writer-wins, so the second supervisor to start
 * in a project made the first unreachable: `npm run build`'s postbuild hook
 * and `config({action:'restart'})` both signalled whichever pid was written
 * last, and the other session kept serving its old code with nothing saying so.
 * Dead pids are dropped here, since a pidfile that only ever grows would send
 * signals to whatever later takes a recycled pid.
 */
export async function recordOwnSupervisor(
  pidFilePath: string,
  own: SupervisorRecord,
  isAlive: (pid: number) => boolean = defaultIsAlive
): Promise<void> {
  const existing = await readSupervisorRecords(pidFilePath);
  const others = existing.filter(record => record.pid !== own.pid && isAlive(record.pid));
  await atomicWriteFile(pidFilePath, serialize([...others, own]));
}

/**
 * Remove ONLY this process's record, and the file itself once no record is
 * left. Deleting the file outright let an old supervisor, exiting hours later,
 * take the live one's entry with it - after which a build signalled nothing,
 * silently.
 */
export async function removeOwnPidFile(pidFilePath: string, ownPid: number): Promise<boolean> {
  const records = await readSupervisorRecords(pidFilePath);
  if (records.length === 0) return false;

  const remaining = records.filter(record => record.pid !== ownPid);
  if (remaining.length === records.length) return false;

  try {
    if (remaining.length === 0) {
      await fs.unlink(pidFilePath);
    } else {
      await atomicWriteFile(pidFilePath, serialize(remaining));
    }
    return true;
  } catch {
    return false;
  }
}
