/**
 * Branches that were dead in production because they read `result.isError`,
 * while the live executeToolCall raises the same failure as a ToolError. Each
 * test drives the THROWN shape - the one that actually happens.
 */

import { describe, it, expect, vi } from 'vitest';
import { autoLaunchChrome, getDebugState, probeLiveConnectionReferences } from './replay-executor.js';
import type { ExecutionContext } from './replay-executor.js';
import { createErrorResponse, createSuccessResponse } from '../messages.js';
import { productionShaped } from '../test-support/fake-execute-tool-call.js';

const harness = (responses: Record<string, any>) =>
  vi.fn(productionShaped(async (tool: string, params: Record<string, any> = {}) => {
    const r = responses[`${tool}.${params.action}`] ?? responses[tool];
    if (r === undefined) return { content: [{ type: 'text', text: '' }] };
    return typeof r === 'function' ? r(params) : r;
  })) as any;

describe('auto-launch failure', () => {
  // The helper is called from inside ensureConnection's catch, so a throw here
  // escaped the run entirely: the caller's LAUNCH_FAILED handling never ran and
  // the user got a raw tool error instead of "launch Chrome manually first".
  it('reports LAUNCH_FAILED when launchChrome throws', async () => {
    const executeToolCall = harness({
      launchChrome: createErrorResponse('CHROME_LAUNCH_TIMEOUT', {
        port: 9222,
        chromePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        probeAttempts: 15,
        elapsedMs: 28500,
        probeFailures: '',
        stderrTail: '',
        profileDir: '',
      }),
    });

    const result = await autoLaunchChrome(executeToolCall, 'device-a-one');

    expect(result.success).toBe(false);
    expect(result).toMatchObject({ errorType: 'LAUNCH_FAILED' });
    expect((result as any).error).toContain('Failed to auto-launch Chrome');
  });

  it('succeeds quietly when Chrome launches', async () => {
    const executeToolCall = harness({ launchChrome: { content: [{ type: 'text', text: 'Chrome launched' }] } });
    expect(await autoLaunchChrome(executeToolCall, 'device-a-one')).toEqual({ success: true });
  });
});

describe('debug state for an unpaused connection', () => {
  const ctx = (executeToolCall: any): ExecutionContext =>
    ({ executeToolCall, connectionReason: 'device-a', logPrefix: 'test' } as any);

  // getCallStack answers "not paused" with an ERROR response, so the whole
  // probe used to be abandoned - discarding the breakpoint count it had
  // already read, for the ordinary unpaused run this exists to describe.
  it('reports the breakpoint count when the debugger is simply not paused', async () => {
    const executeToolCall = harness({
      'breakpoint.list': { content: [{ type: 'text', text: '## Breakpoints\n\n**Total:** 2' }] },
      'inspect.getCallStack': createErrorResponse('NOT_PAUSED'),
    });

    expect(await getDebugState(ctx(executeToolCall))).toEqual({
      isPaused: false,
      pauseLocation: undefined,
      breakpointCount: 2,
    });
  });

  it('reports the pause location when it IS paused', async () => {
    const executeToolCall = harness({
      'breakpoint.list': { content: [{ type: 'text', text: '**Total:** 1' }] },
      'inspect.getCallStack': { content: [{ type: 'text', text: 'Paused at: app.js:42\n{"callFrameId":"f1"}' }] },
    });

    expect(await getDebugState(ctx(executeToolCall))).toMatchObject({
      isPaused: true,
      pauseLocation: 'app.js:42',
      breakpointCount: 1,
    });
  });

  // A failure that is NOT "not paused" still means the state is unknown.
  it('gives up on any other call-stack failure', async () => {
    const executeToolCall = harness({
      'breakpoint.list': { content: [{ type: 'text', text: '**Total:** 1' }] },
      'inspect.getCallStack': createErrorResponse('CONNECTION_NOT_FOUND', { connectionReason: 'device-a' }),
    });

    expect(await getDebugState(ctx(executeToolCall))).toBeNull();
  });
});

describe('live connection probing', () => {
  const connectionsResponse = (connections: any[]) => {
    const response: any = createSuccessResponse('CONNECTIONS_LIST', { count: connections.length });
    response.content[0].text += `\n\n\`\`\`json\n${JSON.stringify({ connections }, null, 2)}\n\`\`\``;
    return response;
  };

  // A reference whose socket has dropped is not somewhere a step can run: if it
  // counted as live, a healing sequence would skip the launch that replaces it.
  it('does not count a disconnected reference as live', async () => {
    const executeToolCall = harness({
      listConnections: connectionsResponse([
        { reference: 'device-a', port: 9222, connected: true },
        { reference: 'device-b', port: 9223, connected: false },
      ]),
    });

    const refs = await probeLiveConnectionReferences(executeToolCall);

    expect(refs && [...refs]).toEqual(['device-a']);
  });

  it('treats an unreadable connection list as unknown, not empty', async () => {
    const executeToolCall = harness({ listConnections: { content: [{ type: 'text', text: 'no json here' }] } });
    expect(await probeLiveConnectionReferences(executeToolCall)).toBeNull();
  });
});
