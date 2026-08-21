/**
 * Which Claude Code session this process serves.
 *
 * Claude Code exports CLAUDE_CODE_SESSION_ID into the environment it spawns
 * the supervisor with, and the child inherits it. That value is present from
 * the first instruction and unchanged when the supervisor replaces the child,
 * so anything naming this session on disk - a mailbox filename, a presence
 * record - keeps the same name across a rebuild.
 *
 * The session detector produces the same id, but only after a tool response
 * carrying a `pid:` footer has been written into the session's .jsonl and
 * matched. A session driven from the CLI writes no such footer, and a child
 * restarted by a rebuild has not written one yet.
 */

/** Ids become filenames; anything outside this set could escape the directory
 *  holding them. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The full session id from the environment, or undefined when this process
 *  was not spawned by Claude Code. */
export function getClaudeSessionId(): string | undefined {
  const value = process.env.CLAUDE_CODE_SESSION_ID;
  if (!value || !SESSION_ID_PATTERN.test(value)) return undefined;
  return value;
}

/** The first 8 characters of the session id - the form the dashboard and the
 *  session detector both display. */
export function getClaudeShortId(): string | undefined {
  return getClaudeSessionId()?.slice(0, 8);
}

/**
 * The name this session is known by on disk - its mailbox filename, its event
 * stream filename, its presence record.
 *
 * The environment comes first: it is present from the first instruction and
 * unchanged when the supervisor replaces the child. The detector's short id is
 * next, for a client that exports no session id. The pid form is last, and
 * changes on every restart, which is why it is the fallback rather than the
 * default.
 */
export function resolveSessionName(detectedShortId?: string): string {
  return getClaudeShortId() ?? detectedShortId ?? `pid-${process.pid}`;
}
