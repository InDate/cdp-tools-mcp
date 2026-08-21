/**
 * Which session a CLI command was typed in.
 *
 * The caller and the session's MCP process meet somewhere up the process tree.
 * Every session under the same terminal or editor shares the outer ancestors,
 * so the meeting point alone is not enough: the session whose shared ancestor
 * is NEAREST the caller is the one whose shell ran the command. Distance is
 * measured in hops from the caller, and the nearest wins.
 */

import type { SessionRecord } from '../session-endpoint.js';
import { collectAncestors, collectChain } from './process-tree.js';

export interface SessionMatch {
  record: SessionRecord;
  /** Hops from the caller to the ancestor it shares with this session. */
  distance: number;
}

export interface MatchResult {
  /** Every session sharing an ancestor, nearest first. */
  candidates: SessionMatch[];
  /** The single nearest session, or null when none matched or two tie. */
  matched: SessionRecord | null;
  /** Set when two sessions are the same distance away. */
  ambiguous: SessionMatch[];
}

export function matchByAncestry(
  records: SessionRecord[],
  callerPid: number,
  parents: Map<number, number>
): MatchResult {
  const callerAncestors = collectAncestors(callerPid, parents);

  const candidates: SessionMatch[] = [];
  for (const record of records) {
    const chain = collectChain(record.pid, parents);
    const distance = callerAncestors.findIndex(pid => chain.has(pid));
    if (distance === -1) continue;
    candidates.push({ record, distance });
  }

  candidates.sort((a, b) => a.distance - b.distance);

  if (candidates.length === 0) {
    return { candidates, matched: null, ambiguous: [] };
  }

  const nearest = candidates[0].distance;
  const tied = candidates.filter(c => c.distance === nearest);
  if (tied.length > 1) {
    return { candidates, matched: null, ambiguous: tied };
  }

  return { candidates, matched: candidates[0].record, ambiguous: [] };
}

/**
 * Records whose process is in the listing.
 *
 * A record survives its process by the moment it takes the supervisor to
 * replace a child, and one absent from the process listing has no chain to
 * walk - it would report as "no shared ancestor", which reads as the caller
 * being in the wrong shell rather than the session being mid-restart. An
 * empty listing means the walk failed entirely, so nothing is filtered.
 */
export function filterToListedProcesses(
  records: SessionRecord[],
  parents: Map<number, number>
): SessionRecord[] {
  if (parents.size === 0) return records;
  return records.filter(record => parents.has(record.pid));
}

/** The session a caller named explicitly: short id, session id, or pid. */
export function findSessionByName(records: SessionRecord[], name: string): SessionRecord | null {
  const asPid = Number(name);
  return (
    records.find(r => r.shortId === name) ??
    records.find(r => r.sessionId === name) ??
    (Number.isInteger(asPid) ? records.find(r => r.pid === asPid) : undefined) ??
    records.find(r => r.sessionId?.startsWith(name)) ??
    null
  );
}
