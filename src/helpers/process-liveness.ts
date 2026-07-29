/**
 * Process liveness, for pid lists that outlive the processes in them.
 *
 * The dashboard hub only removes a pid when its websocket closes cleanly, so a
 * killed or crashed process stays registered. Anything deciding behaviour from
 * a pid list has to check the pids are real first.
 */

/**
 * Whether a pid names a running process.
 *
 * Signal 0 performs the permission and existence checks without delivering
 * anything. EPERM means the process exists and belongs to another user, which
 * is still alive; ESRCH means it is gone.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

/**
 * The live members of a pid list, order preserved.
 *
 * `keep` is always retained even if the check says otherwise — it is normally
 * the caller's own pid, and a self-check that fails should not erase the caller
 * from its own list.
 */
export function livePids(pids: number[], keep?: number): number[] {
  return pids.filter(pid => pid === keep || isProcessAlive(pid));
}
