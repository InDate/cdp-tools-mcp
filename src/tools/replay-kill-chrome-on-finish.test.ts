/**
 * killChromeOnFinish must only tear down the browser behind the RUN's own
 * connection. A step that names its own connectionReason is typically pointing
 * at a long-lived instance the user launched by hand (the multi-device case);
 * killing it would destroy state they cannot get back, so those are left alone.
 */
import { describe, it, expect, vi } from 'vitest';
import { createReplayTools } from './replay-tools.js';
import type { CommandSequence, RecordedCommand } from '../command-recorder.js';

const RUN_PORT = 9222;
const BORROWED_PORT = 9333;

const PORTS: Record<string, number> = {
  'run-device': RUN_PORT,
  'borrowed-device': BORROWED_PORT,
  'phone': 9444,
};

function makeReplay(commands: RecordedCommand[]) {
  const sequence: CommandSequence = { id: 'seq-kill', name: 'kill-seq', commands, createdAt: 1 };

  const recorder = {
    getSequence: vi.fn(() => sequence),
    listSequences: vi.fn(() => [sequence]),
    loadSequenceFromDisk: vi.fn(async () => sequence),
    getHistory: vi.fn(() => []),
    getCurrentHistoryIndex: vi.fn(() => 0),
    recordCommand: vi.fn(),
    setActiveSequence: vi.fn(),
  } as any;

  const calls: Array<{ tool: string; params: Record<string, any> }> = [];
  const executeToolCall = vi.fn(async (tool: string, params: Record<string, any>) => {
    calls.push({ tool, params });
    return { content: [{ type: 'text', text: '' }] };
  });

  const getConnectionPort = vi.fn(async (reference: string) => PORTS[reference] ?? null);

  const { replay } = createReplayTools(
    recorder,
    executeToolCall,
    async () => null,          // no page -> no cursor/overlay injection
    getConnectionPort,
    undefined
  );

  return { replay, calls, getConnectionPort };
}

const killedPorts = (calls: Array<{ tool: string; params: Record<string, any> }>) =>
  calls.filter(c => c.tool === 'killChrome').map(c => c.params.port);

const text = (res: any) => res.content[0].text as string;

const run = (replay: any, extra: Record<string, any> = {}) =>
  replay.handler({
    action: 'run',
    // These tests assert on the run's final text, so they use the blocking mode.
    wait: true,
    sequenceId: 'seq-kill',
    connectionReason: 'run-device',
    killChromeOnFinish: true,
    ...extra,
  } as any);

describe('killChromeOnFinish', () => {
  it("kills the run's own Chrome exactly once", async () => {
    const { replay, calls } = makeReplay([
      { tool: 'dom', params: { action: 'querySelector', selector: '#a' } },
      { tool: 'dom', params: { action: 'querySelector', selector: '#b' } },
    ]);

    const res = await run(replay);

    expect(killedPorts(calls)).toEqual([RUN_PORT]);
    expect(text(res)).toContain('Chrome killed');
  });

  it('leaves a borrowed per-step connection running', async () => {
    const { replay, calls } = makeReplay([
      { tool: 'dom', params: { action: 'querySelector', selector: '#a' } },
      // a browser the user launched themselves and expects to keep
      { tool: 'dom', params: { action: 'querySelector', selector: '#b', connectionReason: 'borrowed-device' } },
    ]);

    await run(replay);

    expect(killedPorts(calls)).toEqual([RUN_PORT]);
    expect(killedPorts(calls)).not.toContain(BORROWED_PORT);
    // the step really did run against the borrowed connection
    expect(calls.some(c => c.tool === 'dom' && c.params.connectionReason === 'borrowed-device')).toBe(true);
  });

  it('leaves a borrowed connection running even when its reference comes from a variable', async () => {
    const { replay, calls, getConnectionPort } = makeReplay([
      { tool: 'dom', params: { action: 'querySelector', selector: '#b', connectionReason: '{{var:device}}' } },
    ]);

    await run(replay);

    expect(killedPorts(calls)).toEqual([RUN_PORT]);
    // and we never even asked for the port of an uninterpolated reference
    expect(getConnectionPort.mock.calls.flat()).toEqual(['run-device']);
  });

  it('kills nothing when killChromeOnFinish is not set', async () => {
    const { replay, calls } = makeReplay([
      { tool: 'dom', params: { action: 'querySelector', selector: '#a', connectionReason: 'borrowed-device' } },
    ]);

    await run(replay, { killChromeOnFinish: undefined });

    expect(killedPorts(calls)).toEqual([]);
  });
});
