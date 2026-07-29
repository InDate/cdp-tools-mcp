import { describe, it, expect } from 'vitest';
import { isProcessAlive, livePids } from './process-liveness.js';

/** A pid that cannot be running: above the platform maximum. */
const DEAD_PID = 4194304;

describe('isProcessAlive', () => {
  it('sees this process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('does not see a pid that cannot exist', () => {
    expect(isProcessAlive(DEAD_PID)).toBe(false);
  });

  it('rejects nonsense rather than throwing', () => {
    // pid 0 and negatives address process GROUPS in kill(2); treating them as
    // live would keep a bogus entry in the list forever.
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(NaN)).toBe(false);
    expect(isProcessAlive(1.5)).toBe(false);
  });
});

describe('livePids', () => {
  it('drops the dead and keeps the living, in order', () => {
    expect(livePids([DEAD_PID, process.pid])).toEqual([process.pid]);
  });

  it('keeps the caller even when the check would drop it', () => {
    // The caller's own pid is definitionally alive; a self-check that failed
    // must not erase it from its own list.
    expect(livePids([DEAD_PID], DEAD_PID)).toEqual([DEAD_PID]);
  });

  it('empties a list of entirely dead pids', () => {
    expect(livePids([DEAD_PID, DEAD_PID + 1])).toEqual([]);
  });

  it('collapses a stale duplicate down to one live pid', () => {
    // The case that blocks a healthy session: a restarted MCP leaves its old
    // pid behind, the list reads as two, and the guard calls it a duplicate.
    const pids = [DEAD_PID, process.pid];
    expect(livePids(pids, process.pid).length).toBe(1);
  });
});
