/**
 * Message tool - text between two devharness sessions on this machine.
 *
 * Transport is `src/session-messages.ts`: one append-only JSONL mailbox per
 * session under `~/.devharness/messages/`. Discovery reuses the dashboard
 * hub's session registry, which already holds every live session's short id,
 * pid and project directory.
 */

import { z } from 'zod';
import { createTool } from '../validation-helpers.js';
import { createSuccessResponse, createErrorResponse } from '../messages.js';
import { isProcessAlive } from '../helpers/process-liveness.js';
import { readLock } from '../dashboard/hub-lock.js';
import { getProjectDir } from '../helpers/paths.js';
import { getSessionInfo } from './dashboard-tools.js';
import type { ToolResponseMeta, MessageToolMeta } from '../tool-response.js';
import type { SessionInfo as DashboardSessionInfo } from '../dashboard/types.js';
import {
  isValidMailboxId,
  getMailboxPath,
  getMessagesDir,
  listMailboxIds,
  readMailbox,
  readCursor,
  writeCursor,
  sendMessage,
  waitForMailbox,
  type SessionMessage,
} from '../session-messages.js';

const messageSchema = z.object({
  action: z.enum(['sessions', 'send', 'read', 'reply'])
    .describe('sessions (list reachable sessions and this one\'s mailbox path), send (write to another session), read (take new messages from this session\'s mailbox), reply (answer a message by id)'),
  to: z.string().optional()
    .describe('send: recipient mailbox id, as reported by action sessions'),
  text: z.string().optional()
    .describe('send/reply: the message body'),
  replyTo: z.string().optional()
    .describe('reply: id of the message being answered - the reply goes to its sender'),
  waitForReplyMs: z.number().int().positive().max(300000).optional()
    .describe('send/reply: hold the call open until a message arrives in this session\'s mailbox, or this many ms elapse (max 300000). Returns on any arrival, not only a tagged reply.'),
  pollIntervalMs: z.number().int().min(100).max(5000).optional()
    .describe('send/reply: interval between mailbox checks while waiting (default 500)'),
}).strict();

type MessageArgs = z.infer<typeof messageSchema>;

const DEFAULT_POLL_INTERVAL_MS = 500;
const HUB_FETCH_TIMEOUT_MS = 1500;

/**
 * The mailbox id this process is reachable at.
 *
 * The short id arrives once the session detector has matched this pid to a
 * Claude Code session file, which takes one tool call. Before that the pid
 * form is the only stable identity, and `sessions` reports whichever form is
 * current so a sender addresses what is live now.
 */
function resolveSelfMailboxId(): string {
  const info = getSessionInfo();
  return info?.shortId ?? `pid-${process.pid}`;
}

function buildMeta(action: MessageArgs['action'], self: string, extra: Partial<MessageToolMeta>): ToolResponseMeta {
  return {
    tool: 'message',
    action,
    timestamp: Date.now(),
    message: { action, self, ...extra },
  };
}

/** Sessions the dashboard hub currently holds, or null when it is unreachable. */
async function fetchHubSessions(): Promise<DashboardSessionInfo[] | null> {
  const lock = readLock();
  if (!lock?.port) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HUB_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`http://localhost:${lock.port}/api/sessions`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as DashboardSessionInfo[];
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** One line per message, newest last, for the rendered response. */
function formatMessages(messages: SessionMessage[]): string {
  return messages
    .map(m => `- [${m.id.slice(0, 8)}] from ${m.from}${m.replyTo ? ` (reply to ${m.replyTo.slice(0, 8)})` : ''} at ${m.at}\n  ${m.text}`)
    .join('\n');
}

export function createMessageTools() {
  return {
    message: createTool(
      'Text between two devharness sessions on this machine. Actions: sessions (who is reachable), send (write to another session, optionally holding the call open for a reply), read (take new messages), reply (answer a message by id).',
      messageSchema,
      async (args: MessageArgs, abortSignal?: AbortSignal) => {
        const self = resolveSelfMailboxId();
        const pollIntervalMs = args.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

        switch (args.action) {
          // ---- sessions ------------------------------------------------------
          case 'sessions': {
            const hubSessions = await fetchHubSessions();
            const mailboxIds = await listMailboxIds();

            const rows: NonNullable<MessageToolMeta['sessions']> = [];
            const seen = new Set<string>();
            const now = Date.now();

            for (const session of hubSessions ?? []) {
              const id = session.shortId ?? `pid-${session.pid}`;
              if (seen.has(id)) continue;
              seen.add(id);
              rows.push({
                id,
                pid: session.pid,
                cwd: session.cwd,
                lastHeartbeatAgeMs: session.lastHeartbeat ? now - session.lastHeartbeat : undefined,
                live: isProcessAlive(session.pid),
                self: id === self,
              });
            }

            // A mailbox with no hub entry is a session that has exited. Listing
            // it keeps a reply to a dead session visible instead of silent.
            for (const id of mailboxIds) {
              if (seen.has(id)) continue;
              seen.add(id);
              rows.push({ id, live: false, self: id === self });
            }

            if (!seen.has(self)) {
              rows.push({ id: self, pid: process.pid, live: true, self: true });
            }

            const response = createSuccessResponse('MESSAGE_SESSIONS', {
              self,
              mailboxPath: getMailboxPath(self),
              messagesDir: getMessagesDir(),
              hubNote: hubSessions === null
                ? 'The dashboard hub is not reachable, so this list comes from mailbox files on disk and liveness is unknown.'
                : '',
              sessionList: rows
                .map(r => `- ${r.id}${r.self ? ' (this session)' : ''} - ${r.live ? 'live' : 'no process'}${r.cwd ? ` - ${r.cwd}` : ''}`)
                .join('\n'),
              count: rows.length,
            });
            return { ...response, _meta: buildMeta('sessions', self, { sessions: rows }) };
          }

          // ---- send / reply --------------------------------------------------
          case 'send':
          case 'reply': {
            if (!args.text) {
              return createErrorResponse('MESSAGE_INVALID_ARGS', {
                message: `message({ action: '${args.action}' }) requires text.`,
              });
            }

            let target: string;
            let replyTo: string | undefined;

            if (args.action === 'reply') {
              if (!args.replyTo) {
                return createErrorResponse('MESSAGE_INVALID_ARGS', {
                  message: "message({ action: 'reply' }) requires replyTo - the id of the message being answered.",
                });
              }
              const own = await readMailbox(self);
              const original = own.find(m => m.id === args.replyTo || m.id.startsWith(args.replyTo!));
              if (!original) {
                return createErrorResponse('MESSAGE_TARGET_UNKNOWN', {
                  target: args.replyTo,
                  reason: `No message with id "${args.replyTo}" in this session's mailbox`,
                  self,
                });
              }
              target = original.from;
              replyTo = original.id;
            } else {
              if (!args.to) {
                return createErrorResponse('MESSAGE_INVALID_ARGS', {
                  message: "message({ action: 'send' }) requires to - a mailbox id from message({ action: 'sessions' }).",
                });
              }
              target = args.to;
            }

            if (!isValidMailboxId(target)) {
              return createErrorResponse('MESSAGE_TARGET_UNKNOWN', {
                target,
                reason: 'Not a valid mailbox id (letters, digits, dot, dash, underscore; 64 chars max)',
                self,
              });
            }
            if (target === self) {
              return createErrorResponse('MESSAGE_INVALID_ARGS', {
                message: `"${target}" is this session's own mailbox - a message to it would never reach another agent.`,
              });
            }

            // The line count is taken BEFORE the append: a reply that lands
            // between the append and the first poll sits past this offset and
            // is returned, rather than being counted as already-read.
            const fromLine = args.waitForReplyMs ? (await readMailbox(self)).length : 0;

            const sent = await sendMessage({
              from: self,
              fromCwd: getProjectDir(),
              to: target,
              text: args.text,
              ...(replyTo ? { replyTo } : {}),
            });

            if (!args.waitForReplyMs) {
              const response = createSuccessResponse('MESSAGE_SENT', {
                to: target,
                id: sent.id,
                shortId: sent.id.slice(0, 8),
                mailboxPath: getMailboxPath(target),
              });
              return { ...response, _meta: buildMeta(args.action, self, { sent }) };
            }

            const waitStart = Date.now();
            const received = await waitForMailbox(self, fromLine, {
              timeoutMs: args.waitForReplyMs,
              pollIntervalMs,
              abortSignal,
            });
            const waitElapsedMs = Date.now() - waitStart;

            if (received.length === 0) {
              return {
                ...createErrorResponse('MESSAGE_REPLY_TIMEOUT', {
                  to: target,
                  timeoutMs: args.waitForReplyMs,
                  id: sent.id.slice(0, 8),
                  self,
                  mailboxPath: getMailboxPath(self),
                }),
                _meta: buildMeta(args.action, self, { sent, waitTimedOut: true, waitElapsedMs }),
              };
            }

            // The wait consumed these lines, so the cursor moves past them and
            // a later `read` does not hand back the same messages.
            await writeCursor(self, fromLine + received.length);

            const response = createSuccessResponse('MESSAGE_REPLY_RECEIVED', {
              to: target,
              count: received.length,
              elapsedMs: waitElapsedMs,
              messageList: formatMessages(received),
            });
            return {
              ...response,
              _meta: buildMeta(args.action, self, { sent, received, waitTimedOut: false, waitElapsedMs }),
            };
          }

          // ---- read ----------------------------------------------------------
          case 'read': {
            const all = await readMailbox(self);
            const cursor = await readCursor(self);
            // A mailbox deleted while a cursor survives would slice past the
            // end and return nothing forever; clamp to the current length.
            const from = Math.min(cursor, all.length);
            const fresh = all.slice(from);
            await writeCursor(self, all.length);

            const response = createSuccessResponse('MESSAGE_INBOX', {
              self,
              count: fresh.length,
              total: all.length,
              mailboxPath: getMailboxPath(self),
              messageList: fresh.length ? formatMessages(fresh) : '(nothing new)',
            });
            return { ...response, _meta: buildMeta('read', self, { received: fresh }) };
          }
        }
      }
    ),
  };
}
