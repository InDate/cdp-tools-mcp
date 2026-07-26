/**
 * Unit tests for isAgentSession() - the pure classifier used by bug-003's
 * fix (issues({action:'resolve'}) must refuse autonomous agents). It only
 * operates on the plain SessionState shape returned by
 * SessionDetector.getState(), so it's tested directly without any real
 * fs.watch/transcript-file plumbing.
 */

import { describe, it, expect } from 'vitest';
import { isAgentSession, type SessionState } from './session-detector.js';

function state(overrides: Partial<SessionState> = {}): SessionState {
  return {
    mainSession: null,
    activeAgents: [],
    entryCount: 0,
    ...overrides,
  };
}

describe('isAgentSession', () => {
  it('classifies as agent when only an agent transcript has matched this process\'s PID', () => {
    const s = state({
      mainSession: null,
      activeAgents: [{ agentId: 'a1', shortId: 'a1', agentFile: '/agent-a1.jsonl', startedAt: Date.now() }],
    });
    expect(isAgentSession(s)).toBe(true);
  });

  it('classifies as human when the main session transcript has matched, even with no agents', () => {
    const s = state({
      mainSession: { sessionId: 'm1', shortId: 'm1', sessionFile: '/m1.jsonl', detectedAt: Date.now() },
      activeAgents: [],
    });
    expect(isAgentSession(s)).toBe(false);
  });

  it('prefers human when both a main session and agents are present (main session wins)', () => {
    const s = state({
      mainSession: { sessionId: 'm1', shortId: 'm1', sessionFile: '/m1.jsonl', detectedAt: Date.now() },
      activeAgents: [{ agentId: 'a1', shortId: 'a1', agentFile: '/agent-a1.jsonl', startedAt: Date.now() }],
    });
    expect(isAgentSession(s)).toBe(false);
  });

  it('defaults to human (fails open) when nothing has been classified yet', () => {
    const s = state({ mainSession: null, activeAgents: [] });
    expect(isAgentSession(s)).toBe(false);
  });
});
