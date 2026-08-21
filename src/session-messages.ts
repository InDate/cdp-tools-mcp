/**
 * Cross-session messages: the mailbox one devharness session appends to and
 * another one reads.
 *
 * Each session owns `~/.devharness/messages/<id>.jsonl`, one JSON object per
 * line. The global directory is required rather than preferred: a supervisor
 * is scoped to a project root, so two sessions in different roots share no
 * process, and only the home directory is reachable from both.
 *
 * One line per message matches `blocks.jsonl`, so a Claude Code Monitor
 * tailing the file delivers a message as soon as it lands and the receiving
 * session runs no poll of its own.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { getOutputPath } from './helpers/paths.js';
import { abortableSleep, throwIfAborted } from './utils/abort.js';

export interface SessionMessage {
  /** Identity a reply carries in `replyTo`. */
  id: string;
  /** Mailbox id of the sender. */
  from: string;
  /** Project directory of the sender, so a listing names the repo. */
  fromCwd?: string;
  /** Mailbox id this line was appended to. */
  to: string;
  text: string;
  /** On a reply, the id of the message it answers. */
  replyTo?: string;
  /** ISO timestamp of the append. */
  at: string;
}

export interface MailboxCursor {
  /** Lines already returned by `read`. The file is append-only, so a line
   *  count is a stable cursor across processes. */
  readLines: number;
}

/** A mailbox id becomes a filename, so anything outside this set would let a
 *  crafted id write outside the messages directory. */
const MAILBOX_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export function isValidMailboxId(id: string): boolean {
  return MAILBOX_ID_PATTERN.test(id) && id !== '.' && id !== '..' && !id.includes('..');
}

export function getMessagesDir(): string {
  return getOutputPath('messages', { global: true });
}

export function getMailboxPath(id: string): string {
  return join(getMessagesDir(), `${id}.jsonl`);
}

function getCursorPath(id: string): string {
  return join(getMessagesDir(), `${id}.cursor.json`);
}

/** Read a whole file, or an empty string when it does not exist yet. An
 *  absent mailbox is a session that has received nothing, not a failure. */
async function readFileOrEmpty(path: string): Promise<string> {
  try {
    return await fs.readFile(path, 'utf-8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return '';
    throw err;
  }
}

/** Every message in a mailbox, oldest first. A line that does not parse is
 *  skipped: one torn write must not hide every message after it. */
export async function readMailbox(id: string): Promise<SessionMessage[]> {
  const raw = await readFileOrEmpty(getMailboxPath(id));
  const out: SessionMessage[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as SessionMessage);
    } catch {
      continue;
    }
  }
  return out;
}

/** Mailbox ids that have a file on disk. Covers sessions that have exited,
 *  which is what makes a reply to a dead session visible rather than silent. */
export async function listMailboxIds(): Promise<string[]> {
  try {
    const entries = await fs.readdir(getMessagesDir());
    return entries
      .filter(name => name.endsWith('.jsonl'))
      .map(name => name.slice(0, -'.jsonl'.length))
      .sort();
  } catch (err: any) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

export interface SendMessageInput {
  from: string;
  fromCwd?: string;
  to: string;
  text: string;
  replyTo?: string;
}

/** Append one message to the recipient's mailbox and return the line written. */
export async function sendMessage(input: SendMessageInput): Promise<SessionMessage> {
  const message: SessionMessage = {
    id: randomUUID(),
    from: input.from,
    ...(input.fromCwd ? { fromCwd: input.fromCwd } : {}),
    to: input.to,
    text: input.text,
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    at: new Date().toISOString(),
  };

  await fs.mkdir(getMessagesDir(), { recursive: true });
  await fs.appendFile(getMailboxPath(input.to), JSON.stringify(message) + '\n');
  return message;
}

export async function readCursor(id: string): Promise<number> {
  const raw = await readFileOrEmpty(getCursorPath(id));
  if (!raw.trim()) return 0;
  try {
    const parsed = JSON.parse(raw) as MailboxCursor;
    return Number.isInteger(parsed.readLines) && parsed.readLines >= 0 ? parsed.readLines : 0;
  } catch {
    return 0;
  }
}

export async function writeCursor(id: string, readLines: number): Promise<void> {
  await fs.mkdir(getMessagesDir(), { recursive: true });
  const cursor: MailboxCursor = { readLines };
  await fs.writeFile(getCursorPath(id), JSON.stringify(cursor));
}

export interface WaitForMailboxOptions {
  timeoutMs: number;
  pollIntervalMs: number;
  abortSignal?: AbortSignal;
}

/**
 * Poll `id`'s mailbox until it holds more than `fromLine` messages, and return
 * the ones past that point. An empty array means the timeout elapsed with
 * nothing new.
 *
 * The return fires on ANY new message, not only one whose `replyTo` matches.
 * Two sessions that block at the same moment are both inside this loop and
 * neither is reading its mailbox; returning on any arrival releases both,
 * where a reply-tagged match would hold each until its own timeout.
 */
export async function waitForMailbox(
  id: string,
  fromLine: number,
  options: WaitForMailboxOptions
): Promise<SessionMessage[]> {
  const start = Date.now();

  while (true) {
    throwIfAborted(options.abortSignal);

    const messages = await readMailbox(id);
    if (messages.length > fromLine) {
      return messages.slice(fromLine);
    }

    const elapsed = Date.now() - start;
    if (elapsed + options.pollIntervalMs > options.timeoutMs) {
      return [];
    }
    await abortableSleep(options.pollIntervalMs, options.abortSignal);
  }
}
