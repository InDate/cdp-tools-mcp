/**
 * Tests for reading the Claude Code session id out of the environment.
 *
 * The id becomes a filename, so a value that could traverse out of the
 * directory holding mailboxes and presence records is rejected rather than
 * sanitised - a sanitised name would silently address a different session.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getClaudeSessionId, getClaudeShortId } from './session-identity.js';

let previous: string | undefined;

beforeEach(() => { previous = process.env.CLAUDE_CODE_SESSION_ID; });
afterEach(() => {
  if (previous === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = previous;
});

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
