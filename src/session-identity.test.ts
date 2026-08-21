/**
 * Tests for reading the Claude Code session id out of the environment.
 *
 * The id becomes a filename, so a value that could traverse out of the
 * directory holding mailboxes and presence records is rejected rather than
 * sanitised - a sanitised name would silently address a different session.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initializePaths } from './helpers/paths.js';
import {
  getClaudeSessionId,
  getClaudeShortId,
  getClientPid,
  readCurrentSessionId,
  resolveSessionName,
  getClientRecordPath,
} from './session-identity.js';

let previous: string | undefined;
let previousSocket: string | undefined;
let previousDir: string | undefined;
let dir: string;

beforeEach(() => {
  previous = process.env.CLAUDE_CODE_SESSION_ID;
  previousSocket = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  previousDir = process.env.DEVHARNESS_DIR;
  dir = mkdtempSync(join(tmpdir(), 'devharness-identity-'));
  process.env.DEVHARNESS_DIR = dir;
  initializePaths();
});
afterEach(() => {
  if (previous === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = previous;
  if (previousSocket === undefined) delete process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  else process.env.CLAUDE_CODE_MESSAGING_SOCKET = previousSocket;
  if (previousDir === undefined) delete process.env.DEVHARNESS_DIR;
  else process.env.DEVHARNESS_DIR = previousDir;
  initializePaths();
  rmSync(dir, { recursive: true, force: true });
});

/** What the hook writes when a conversation starts or is cleared. */
function hookRecorded(clientPid: number, sessionId: string): void {
  const path = getClientRecordPath(clientPid);
  mkdirSync(join(dir, 'clients'), { recursive: true });
  writeFileSync(path, JSON.stringify({ sessionId, at: '2026-08-21T00:00:00.000Z' }));
}

describe('getClaudeSessionId', () => {
  it('returns the exported id', () => {
    process.env.CLAUDE_CODE_SESSION_ID = '2e9119bf-672e-4ad8-89c1-f44fcd1060d8';
    expect(getClaudeSessionId()).toBe('2e9119bf-672e-4ad8-89c1-f44fcd1060d8');
  });

  it('returns undefined when the process was not spawned by Claude Code', () => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    expect(getClaudeSessionId()).toBeUndefined();
    expect(getClaudeShortId()).toBeUndefined();
  });

  it('returns undefined for an empty value', () => {
    process.env.CLAUDE_CODE_SESSION_ID = '';
    expect(getClaudeSessionId()).toBeUndefined();
  });

  it('rejects a value that would write outside the directory naming it', () => {
    for (const bad of ['../escape', 'a/b', '..', '.hidden', 'has space', 'x'.repeat(200)]) {
      process.env.CLAUDE_CODE_SESSION_ID = bad;
      expect(getClaudeSessionId()).toBeUndefined();
    }
  });
});

describe('getClaudeShortId', () => {
  it('is the first eight characters, the form the dashboard shows', () => {
    process.env.CLAUDE_CODE_SESSION_ID = '2e9119bf-672e-4ad8-89c1-f44fcd1060d8';
    expect(getClaudeShortId()).toBe('2e9119bf');
  });

  it('returns a short id shorter than eight characters unchanged', () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'abc';
    expect(getClaudeShortId()).toBe('abc');
  });
});

describe('getClientPid', () => {
  it('reads the Claude pid out of the messaging socket path', () => {
    process.env.CLAUDE_CODE_MESSAGING_SOCKET = '/tmp/cc-socks/61220.sock';
    expect(getClientPid()).toBe(61220);
  });

  it('returns undefined when no socket is exported', () => {
    delete process.env.CLAUDE_CODE_MESSAGING_SOCKET;
    expect(getClientPid()).toBeUndefined();
  });

  it('returns undefined for a socket path that names no pid', () => {
    process.env.CLAUDE_CODE_MESSAGING_SOCKET = '/tmp/cc-socks/not-a-pid.sock';
    expect(getClientPid()).toBeUndefined();
  });
});

describe('resolveSessionName - following a conversation through a clear', () => {
  beforeEach(() => {
    process.env.CLAUDE_CODE_MESSAGING_SOCKET = '/tmp/cc-socks/61220.sock';
    // The value this process was spawned with, which /clear does not update.
    process.env.CLAUDE_CODE_SESSION_ID = 'aaaaaaaa-1111-2222-3333-444444444444';
  });

  it('uses the environment while the hook has recorded the same conversation', () => {
    hookRecorded(61220, 'aaaaaaaa-1111-2222-3333-444444444444');
    expect(resolveSessionName()).toBe('aaaaaaaa');
  });

  it('follows the hook to the new conversation after a clear', () => {
    hookRecorded(61220, 'bbbbbbbb-9999-0000-1111-222222222222');
    expect(readCurrentSessionId()).toBe('bbbbbbbb-9999-0000-1111-222222222222');
    expect(resolveSessionName()).toBe('bbbbbbbb');
  });

  it('falls back to the environment when no hook has run', () => {
    expect(readCurrentSessionId()).toBeUndefined();
    expect(resolveSessionName()).toBe('aaaaaaaa');
  });

  it('falls back to the environment when the record names a different client', () => {
    hookRecorded(99999, 'bbbbbbbb-9999');
    expect(resolveSessionName()).toBe('aaaaaaaa');
  });

  it('ignores a recorded id that would escape the directory naming it', () => {
    hookRecorded(61220, '../../escape');
    expect(readCurrentSessionId()).toBeUndefined();
    expect(resolveSessionName()).toBe('aaaaaaaa');
  });

  it('falls back to the detector when neither the record nor the environment has one', () => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    expect(resolveSessionName('cccccccc')).toBe('cccccccc');
  });
});
