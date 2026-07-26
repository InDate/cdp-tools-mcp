/**
 * Unit tests for bug-003's fix: issues({action:'resolve'}) must never let an
 * autonomous agent (no human present) fall into the interactive
 * verification flow, and even a genuine human-attended flow must be bounded
 * so a person walking away can't leak a raw Puppeteer protocol timeout.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setWorkingDirOverride } from '../helpers/paths.js';
import { __resetForTests, addIssue, getIssue } from '../issue-tracker.js';
import { createIssuesTools, DEFAULT_RESOLVE_VERIFICATION_TIMEOUT_MS } from './issues-tools.js';

// showTestReadyOverlay/showVerificationOverlay both drive page.evaluate() and
// resolve only when a human clicks a button in the browser - mock them so
// tests control exactly when (or whether) that "click" happens.
const showTestReadyOverlay = vi.fn();
const showVerificationOverlay = vi.fn();
vi.mock('../interaction-recorder.js', () => ({
  showTestReadyOverlay: (...args: any[]) => showTestReadyOverlay(...args),
  showVerificationOverlay: (...args: any[]) => showVerificationOverlay(...args),
}));

let tempDir: string;

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(join(tmpdir(), 'cdp-tools-issues-tools-test-'));
  setWorkingDirOverride(tempDir);
  __resetForTests();
  showTestReadyOverlay.mockReset();
  showVerificationOverlay.mockReset();
});

afterEach(async () => {
  __resetForTests();
  vi.useRealTimers();
  await fsp.rm(tempDir, { recursive: true, force: true });
});

function buildTools(opts: {
  isAgentCaller?: () => boolean;
  executeToolCall?: (toolName: string, params: Record<string, any>) => Promise<any>;
} = {}) {
  const executeToolCall = opts.executeToolCall ?? vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '' }] });
  const getPageForConnection = vi.fn().mockResolvedValue({ evaluate: vi.fn() });
  const tools = createIssuesTools(executeToolCall, undefined, getPageForConnection, opts.isAgentCaller);
  return { tools, executeToolCall, getPageForConnection };
}

describe('issues resolve - agent refusal (bug-003)', () => {
  it('fails immediately with ISSUES_RESOLVE_REQUIRES_HUMAN when called by an agent, without touching the browser or issue state', async () => {
    const issue = await addIssue({ type: 'bug', title: 'Something broke', sequenceFile: 'x.json' });
    const { tools, executeToolCall, getPageForConnection } = buildTools({ isAgentCaller: () => true });

    const result = await tools.issues.handler({ action: 'resolve', id: issue.id } as any, undefined);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('resolve requires human verification');
    expect(result.content[0].text).toContain("cannot be called by an agent");

    // Genuine no-op: no browser touched, no overlay shown, no state change.
    expect(getPageForConnection).not.toHaveBeenCalled();
    expect(executeToolCall).not.toHaveBeenCalled();
    expect(showTestReadyOverlay).not.toHaveBeenCalled();
    expect(showVerificationOverlay).not.toHaveBeenCalled();

    const reloaded = await getIssue(issue.id);
    expect(reloaded!.status).toBe(issue.status); // unchanged
    expect(reloaded!.resolvedAt).toBeUndefined();
  });

  it('proceeds into the interactive flow when the caller is not classified as an agent', async () => {
    const issue = await addIssue({ type: 'bug', title: 'Something broke', sequenceFile: 'x.json' });
    showTestReadyOverlay.mockResolvedValue('cancel');
    const { tools } = buildTools({ isAgentCaller: () => false });

    const result = await tools.issues.handler({ action: 'resolve', id: issue.id } as any, undefined);

    expect(showTestReadyOverlay).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain('cancelled');
  });

  it('proceeds into the interactive flow when no isAgentCaller callback is wired up at all', async () => {
    const issue = await addIssue({ type: 'bug', title: 'Something broke', sequenceFile: 'x.json' });
    showTestReadyOverlay.mockResolvedValue('cancel');
    const { tools } = buildTools(); // isAgentCaller omitted entirely

    await tools.issues.handler({ action: 'resolve', id: issue.id } as any, undefined);

    expect(showTestReadyOverlay).toHaveBeenCalledTimes(1);
  });
});

describe('issues resolve - bounded human-verification timeout (bug-003 follow-on)', () => {
  it('returns a typed ISSUES_RESOLVE_TIMEOUT error, and closes the tab, if nobody ever answers the "ready to begin?" overlay', async () => {
    vi.useFakeTimers();
    const issue = await addIssue({ type: 'bug', title: 'Something broke', sequenceFile: 'x.json' });

    // Simulates a human who never clicks anything - the overlay's promise never settles.
    showTestReadyOverlay.mockReturnValue(new Promise(() => {}));

    const executeToolCall = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '' }] });
    const { tools } = buildTools({ isAgentCaller: () => false, executeToolCall });

    const resultPromise = tools.issues.handler({ action: 'resolve', id: issue.id } as any, undefined);
    await vi.advanceTimersByTimeAsync(DEFAULT_RESOLVE_VERIFICATION_TIMEOUT_MS + 1000);
    const result = await resultPromise;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Timed out after');
    expect(result.content[0].text).toContain('waiting for a human to respond');
    expect(executeToolCall).toHaveBeenCalledWith('tab', expect.objectContaining({ action: 'close' }));

    const reloaded = await getIssue(issue.id);
    expect(reloaded!.resolvedAt).toBeUndefined(); // no-op on issue state
  });

  it('never lets the overall wait exceed the bound even though Puppeteer\'s own protocolTimeout (180s) is longer', () => {
    // This is the crux of the bug-003 "bound the interactive path" requirement:
    // our own timeout (150s) must fire strictly before Puppeteer's default
    // protocolTimeout (180s) would, so callers get our typed error instead of
    // a raw "Runtime.callFunctionOn timed out".
    const PUPPETEER_DEFAULT_PROTOCOL_TIMEOUT_MS = 180_000;
    expect(DEFAULT_RESOLVE_VERIFICATION_TIMEOUT_MS).toBeLessThan(PUPPETEER_DEFAULT_PROTOCOL_TIMEOUT_MS);
  });
});
