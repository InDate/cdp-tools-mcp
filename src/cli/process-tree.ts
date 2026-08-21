/**
 * Parent lookup over the process tree.
 *
 * A CLI invoked from a session's shell and that session's MCP process share an
 * ancestor: both descend from the Claude Code process that owns the session.
 * That shared ancestor is what identifies which session the command was typed
 * in, so the whole pid -> ppid map is read once and walked in memory rather
 * than spawning `ps` per hop.
 */

import { execFileSync } from 'child_process';

/** Every pid on the machine mapped to its parent. An empty map means the
 *  process listing failed, which leaves matching with nothing to go on. */
export function readParentMap(): Map<number, number> {
  const parents = new Map<number, number>();

  try {
    const output = process.platform === 'win32'
      ? execFileSync(
          'powershell',
          ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'],
          { encoding: 'utf-8', timeout: 5000 }
        )
      : execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf-8', timeout: 5000 });

    for (const line of output.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (!match) continue;
      parents.set(Number(match[1]), Number(match[2]));
    }
  } catch {
    return parents;
  }

  return parents;
}

/**
 * Ancestors of `pid`, nearest parent first, excluding `pid` itself and the
 * init process. The walk stops on a repeat so a cycle in a malformed listing
 * cannot spin.
 */
export function collectAncestors(pid: number, parents: Map<number, number>): number[] {
  const ancestors: number[] = [];
  const seen = new Set<number>([pid]);

  let current = parents.get(pid);
  while (current !== undefined && current > 1 && !seen.has(current)) {
    ancestors.push(current);
    seen.add(current);
    current = parents.get(current);
  }

  return ancestors;
}

/** `pid` and everything above it, for testing membership of a session's chain. */
export function collectChain(pid: number, parents: Map<number, number>): Set<number> {
  return new Set<number>([pid, ...collectAncestors(pid, parents)]);
}
