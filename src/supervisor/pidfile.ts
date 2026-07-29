import { promises as fs } from 'fs';

/**
 * Remove the supervisor pidfile ONLY if it still names this process.
 *
 * The pidfile is last-writer-wins: a second supervisor starting in the same
 * project overwrites it. Deleting it unconditionally on shutdown therefore let
 * an OLD supervisor, exiting hours later, delete the LIVE one's pidfile - after
 * which `npm run build` signalled nothing, silently, and the running session
 * stopped receiving rebuilds while appearing healthy.
 */
export async function removeOwnPidFile(pidFilePath: string, ownPid: number): Promise<boolean> {
  try {
    const contents = await fs.readFile(pidFilePath, 'utf-8');
    if (parseInt(contents.trim(), 10) !== ownPid) return false;
  } catch {
    // Already gone, or unreadable - nothing of ours to remove.
    return false;
  }

  try {
    await fs.unlink(pidFilePath);
    return true;
  } catch {
    return false;
  }
}
