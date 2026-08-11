/**
 * Typed `gh` operations for issues, and the pure policy that decides what a
 * sync should do. The policy is separated so the truth table is testable
 * without a subprocess.
 */

import { createHash } from 'crypto';
import { runGh, runGhJson, type RunGhOptions } from './gh-cli.js';
import {
  completedStatusFor,
  isCompletedStatus,
  type IssueClosedReason,
  type IssueStatus,
  type TrackedIssue,
} from '../issue-tracker.js';

export interface RemoteComment {
  id: string;
  body: string;
  createdAt: string;
}

export interface RemoteIssue {
  number: number;
  title: string;
  body: string;
  state: 'OPEN' | 'CLOSED';
  stateReason?: string | null;
  labels: string[];
  updatedAt: string;
  url: string;
  comments: RemoteComment[];
}

/** The subset `gh issue list` returns - no body, no comments. */
export type RemoteIssueSummary = Omit<RemoteIssue, 'body' | 'title' | 'comments'>;

function repoArgs(repo?: string): string[] {
  return repo ? ['--repo', repo] : [];
}

function normaliseLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(l => (typeof l === 'string' ? l : (l as { name?: string })?.name))
    .filter((l): l is string => typeof l === 'string' && l.length > 0);
}

export async function ghRepoName(repo?: string, opts?: RunGhOptions): Promise<string> {
  if (repo) return repo;
  const result = await runGhJson<{ nameWithOwner: string }>(['repo', 'view', '--json', 'nameWithOwner'], opts);
  return result.nameWithOwner;
}

export async function ghExistingLabels(repo?: string, opts?: RunGhOptions): Promise<Set<string>> {
  const raw = await runGhJson<Array<{ name: string }>>(
    ['label', 'list', '--limit', '200', '--json', 'name', ...repoArgs(repo)], opts
  );
  return new Set(raw.map(l => l.name));
}

export async function ghCreateLabel(name: string, repo?: string, opts?: RunGhOptions): Promise<void> {
  await runGh(['label', 'create', name, ...repoArgs(repo)], opts);
}

/** `gh issue create` has no --json; it prints the URL. */
export async function ghCreateIssue(
  params: { title: string; body: string; labels: string[]; repo?: string },
  opts?: RunGhOptions
): Promise<{ number: number; url: string } | { number: null; url: string; raw: string }> {
  const args = ['issue', 'create', '--title', params.title, '--body-file', '-', ...repoArgs(params.repo)];
  for (const label of params.labels) args.push('--label', label);

  const stdout = await runGh(args, { ...opts, stdin: params.body });
  const match = stdout.match(/\/issues\/(\d+)\s*$/m);
  const url = stdout.trim().split(/\s+/).pop() ?? stdout.trim();
  // The issue exists either way - an unparseable number is a stamping
  // problem, never a create failure.
  return match ? { number: parseInt(match[1], 10), url } : { number: null, url, raw: stdout };
}

export async function ghViewIssue(number: number, repo?: string, opts?: RunGhOptions): Promise<RemoteIssue> {
  const raw = await runGhJson<any>([
    'issue', 'view', String(number),
    '--json', 'number,title,body,state,stateReason,labels,updatedAt,url,comments',
    ...repoArgs(repo),
  ], opts);

  return {
    number: raw.number,
    title: raw.title ?? '',
    body: raw.body ?? '',
    state: raw.state === 'CLOSED' ? 'CLOSED' : 'OPEN',
    stateReason: raw.stateReason ?? null,
    labels: normaliseLabels(raw.labels),
    updatedAt: raw.updatedAt,
    url: raw.url,
    comments: (raw.comments ?? []).map((c: any) => ({
      id: String(c.id ?? c.url ?? ''),
      body: c.body ?? '',
      createdAt: c.createdAt ?? '',
    })),
  };
}

export async function ghListIssues(repo?: string, opts?: RunGhOptions): Promise<RemoteIssueSummary[]> {
  const raw = await runGhJson<any[]>([
    'issue', 'list', '--state', 'all', '--limit', '200',
    '--json', 'number,state,stateReason,labels,updatedAt,url',
    ...repoArgs(repo),
  ], opts);

  return raw.map(r => ({
    number: r.number,
    state: r.state === 'CLOSED' ? 'CLOSED' : 'OPEN',
    stateReason: r.stateReason ?? null,
    labels: normaliseLabels(r.labels),
    updatedAt: r.updatedAt,
    url: r.url,
  }));
}

export async function ghEditBody(number: number, body: string, repo?: string, opts?: RunGhOptions): Promise<void> {
  await runGh(['issue', 'edit', String(number), '--body-file', '-', ...repoArgs(repo)], { ...opts, stdin: body });
}

export async function ghAddComment(number: number, body: string, repo?: string, opts?: RunGhOptions): Promise<void> {
  await runGh(['issue', 'comment', String(number), '--body-file', '-', ...repoArgs(repo)], { ...opts, stdin: body });
}

export async function ghCloseIssue(
  number: number, reason: IssueClosedReason, repo?: string, opts?: RunGhOptions
): Promise<void> {
  const ghReason = reason === 'not_planned' ? 'not planned' : reason;
  await runGh(['issue', 'close', String(number), '--reason', ghReason, ...repoArgs(repo)], opts);
}

// =============================================================================
// Comment identity
// =============================================================================

/** Hidden marker naming the upstream comment a local comment came from. It
 *  lives inside the comment text, so it needs no schema change and survives
 *  the existing parse/serialize round trip. */
const GH_COMMENT_MARKER_RE = /^<!-- gh: (.+?) -->\r?\n?/;

export function markComment(id: string, body: string): string {
  return `<!-- gh: ${id} -->\n${body}`;
}

export function commentGithubId(text: string): string | null {
  const match = text.match(GH_COMMENT_MARKER_RE);
  return match ? match[1] : null;
}

export function stripCommentMarker(text: string): string {
  return text.replace(GH_COMMENT_MARKER_RE, '');
}

/** The `<!-- devharness: local #N -->` marker publish appends to the GitHub
 *  body. It is upstream-only metadata: strip it from anything stored or
 *  hashed locally, or a pull-then-push cycle accretes one marker per sync. */
const LOCAL_MARKER_RE = /\n*<!--\s*devharness: local #\d+\s*-->/g;

export function stripLocalMarker(body: string): string {
  return body.replace(LOCAL_MARKER_RE, '');
}

// =============================================================================
// Sync policy (pure)
// =============================================================================

export function bodyHash(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 16);
}

export function closedReasonFrom(stateReason: string | null | undefined): IssueClosedReason {
  const value = (stateReason ?? '').toLowerCase().replace(/\s+/g, '_');
  if (value === 'not_planned' || value === 'duplicate') return value;
  return 'completed';
}

export type SyncAction =
  | { kind: 'none' }
  | { kind: 'pull' }
  | { kind: 'push' }
  | { kind: 'conflict' }
  | { kind: 'missing-upstream' };

export interface SyncClassification {
  action: SyncAction['kind'];
  localChanged: boolean;
  remoteChanged: boolean;
  /** First sync for this issue - adopt rather than claim a conflict. */
  firstSync: boolean;
}

/**
 * Which side moved since the two last agreed.
 *
 * With no baseline this is a first sync: adopt whichever side has content
 * rather than reporting a conflict on an issue nobody has actually edited.
 */
export function classifySync(
  local: Pick<TrackedIssue, 'body' | 'githubBodyHash' | 'githubSyncedAt'>,
  remote: { updatedAt: string } | undefined,
  strippedLocalBody: string
): SyncClassification {
  if (!remote) {
    return { action: 'missing-upstream', localChanged: false, remoteChanged: false, firstSync: false };
  }

  const firstSync = !local.githubSyncedAt || !local.githubBodyHash;
  if (firstSync) {
    return { action: 'pull', localChanged: false, remoteChanged: true, firstSync: true };
  }

  const localChanged = bodyHash(strippedLocalBody) !== local.githubBodyHash;
  const remoteChanged = new Date(remote.updatedAt).getTime() > local.githubSyncedAt!.getTime();

  let action: SyncAction['kind'] = 'none';
  if (localChanged && remoteChanged) action = 'conflict';
  else if (remoteChanged) action = 'pull';
  else if (localChanged) action = 'push';

  return { action, localChanged, remoteChanged, firstSync: false };
}

export interface StatusResolution {
  status?: IssueStatus;
  closedReason?: IssueClosedReason;
  resolvedAt?: Date;
  /** Upstream is open while we think it is closed - close it up there. */
  closeUpstream?: IssueClosedReason;
  reopened?: boolean;
}

/**
 * How local status and upstream state reconcile.
 *
 * devharness closes issues upstream but never reopens them; GitHub can do
 * both locally. That asymmetry is what keeps an automated sync from undoing
 * a human's decision on a public issue.
 */
export function resolveStatus(
  local: Pick<TrackedIssue, 'type' | 'status' | 'closedReason' | 'startedAt' | 'resolvedAt'>,
  remote: Pick<RemoteIssueSummary, 'state' | 'stateReason'>,
  now: Date
): StatusResolution {
  const localClosed = isCompletedStatus(local.status);

  if (remote.state === 'CLOSED') {
    const closedReason = closedReasonFrom(remote.stateReason);
    if (localClosed) return { closedReason };
    return { status: completedStatusFor(local.type), closedReason, resolvedAt: now };
  }

  // Upstream is open.
  if (!localClosed) return {};

  // Closed here and open there. If we had recorded a close, GitHub reopened
  // it - follow. Otherwise this close has not reached GitHub yet.
  if (local.closedReason) {
    return {
      status: local.startedAt ? 'in_progress' : 'acknowledged',
      closedReason: undefined,
      resolvedAt: undefined,
      reopened: true,
    };
  }

  return { closeUpstream: 'completed' };
}

/** Upstream labels are added, never removed - a replace would delete exactly
 *  the local-only tags that carry the triage meaning. */
export function unionLabels(local: string[], remote: string[]): string[] {
  const merged = [...local];
  for (const label of remote) if (!merged.includes(label)) merged.push(label);
  return merged;
}
