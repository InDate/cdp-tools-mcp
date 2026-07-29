/**
 * A click retries while the element is still mounting, and gives up at once on
 * anything else. The predicate used to be a bare `includes('not found')`, which
 * also caught CONNECTION_NOT_FOUND and SEQUENCE_NOT_FOUND - so a click against a
 * dead connection spent five attempts and 2.5s re-asking a question that was
 * answered on the first one.
 */

import { describe, it, expect, vi } from 'vitest';
import { executeCommandWithRetry } from './replay-executor.js';
import { createErrorResponse } from '../messages.js';
import { ToolError } from '../tool-error.js';

const click = { action: 'click', selector: '#go' };

/** Fails `failures` times with `response`, then succeeds. */
function flaky(response: any, failures: number) {
  let calls = 0;
  const executeToolCall = vi.fn(async () => {
    if (++calls <= failures) throw new ToolError(response);
    return { content: [{ type: 'text', text: 'Clicked' }] };
  });
  return { executeToolCall, calls: () => calls };
}

describe('element-not-found retries', () => {
  it('retries a click while the element is still absent, then succeeds', async () => {
    const { executeToolCall, calls } = flaky(createErrorResponse('ELEMENT_NOT_FOUND', { selector: '#go' }), 1);
    const result = await executeCommandWithRetry(executeToolCall as any, 'input', click);
    expect(result.success).toBe(true);
    expect(calls()).toBe(2);
  });

  // The tightening: these all contain "not found" but none of them will start
  // working if you ask again.
  it.each(['CONNECTION_NOT_FOUND', 'SEQUENCE_NOT_FOUND', 'SERVER_NOT_FOUND'])(
    'does not retry %s',
    async (messageId) => {
      const { executeToolCall, calls } = flaky(createErrorResponse(messageId, { reference: 'x', name: 'x', id: 'x' }), 99);
      const result = await executeCommandWithRetry(executeToolCall as any, 'input', click);
      expect(result.success).toBe(false);
      expect(calls()).toBe(1);
    }
  );

  it('does not retry a non-retryable tool even for a missing element', async () => {
    const { executeToolCall, calls } = flaky(createErrorResponse('ELEMENT_NOT_FOUND', { selector: '#go' }), 99);
    const result = await executeCommandWithRetry(executeToolCall as any, 'dom', { action: 'querySelector', selector: '#go' });
    expect(result.success).toBe(false);
    expect(calls()).toBe(1);
  });

  // No _errorId to read: the text is all there is to go on.
  it('classifies a puppeteer-phrased failure carrying no error id', async () => {
    let n = 0;
    const executeToolCall = vi.fn(async () => {
      if (++n === 1) throw new Error('No element found for selector: #go');
      return { content: [{ type: 'text', text: 'Clicked' }] };
    });
    const result = await executeCommandWithRetry(executeToolCall as any, 'input', click);
    expect(result.success).toBe(true);
    expect(n).toBe(2);
  });
});
