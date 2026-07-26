/**
 * bug-010: sequence steps naming a nonexistent tool must be rejected at
 * create/load time, before any step has mutated browser state.
 */
import { describe, it, expect, vi } from 'vitest';
import { createReplayTools, findUnknownStepTools } from './replay-tools.js';
import { CommandRecorder } from '../command-recorder.js';
import type { CommandSequence, RecordedCommand } from '../command-recorder.js';

const KNOWN_TOOLS = ['navigate', 'inspect', 'input', 'screenshot', 'launchChrome'];

const seq = (commands: RecordedCommand[], name = 'hand-authored'): CommandSequence => ({
  id: 'seq-1',
  name,
  commands,
  createdAt: 1,
});

function makeRecorder(sequence: CommandSequence | null) {
  return {
    loadSequenceFromDisk: vi.fn(async () => sequence),
    // Mirrors the real recorder: the candidate is validated BEFORE it is stored,
    // and a rejected candidate is never stored at all (nothing to delete after).
    createSequence: vi.fn(async (_name: string, _indices: number[], options?: any) => {
      if (sequence && options?.validate && !options.validate(sequence)) return null;
      return sequence;
    }),
    deleteSequence: vi.fn(() => true),
    recordCommand: vi.fn(),
  } as any;
}

function makeReplay(sequence: CommandSequence | null, getKnownToolNames?: () => string[]) {
  const recorder = makeRecorder(sequence);
  const tools = createReplayTools(
    recorder,
    vi.fn(),
    undefined,
    undefined,
    getKnownToolNames
  );
  return { recorder, replay: tools.replay };
}

const text = (res: any) => res.content[0].text as string;

// ---------------------------------------------------------------------------
// findUnknownStepTools
// ---------------------------------------------------------------------------

describe('findUnknownStepTools', () => {
  it('returns nothing when every step names a known tool', () => {
    const commands = [{ tool: 'navigate' }, { tool: 'inspect' }];
    expect(findUnknownStepTools(commands, KNOWN_TOOLS)).toEqual([]);
  });

  it('reports 1-based step number and offending name', () => {
    const commands = [{ tool: 'navigate' }, { tool: 'inpsect' }, { tool: 'nope' }];
    const unknown = findUnknownStepTools(commands, KNOWN_TOOLS);
    expect(unknown.map(u => ({ step: u.step, tool: u.tool }))).toEqual([
      { step: 2, tool: 'inpsect' },
      { step: 3, tool: 'nope' },
    ]);
  });

  it('suggests a near-miss tool name for a typo', () => {
    const [unknown] = findUnknownStepTools([{ tool: 'inpsect' }], KNOWN_TOOLS);
    expect(unknown.suggestion).toBe('inspect');
  });

  it('accepts the "conditional" virtual step, which is not a registered tool', () => {
    expect(findUnknownStepTools([{ tool: 'conditional' }], KNOWN_TOOLS)).toEqual([]);
  });

  it('flags a non-string tool field instead of throwing', () => {
    const unknown = findUnknownStepTools([{ tool: undefined }, {}], KNOWN_TOOLS);
    expect(unknown).toHaveLength(2);
  });

  it('does not inspect params (interpolation tokens must stay valid)', () => {
    const commands = [
      { tool: 'input', params: { action: 'click', x: '{{var:pos.x}}' } },
      { tool: 'navigate', params: { url: '{{var:base}}/page?t={{timestamp}}' } },
    ];
    expect(findUnknownStepTools(commands as any, KNOWN_TOOLS)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// load
// ---------------------------------------------------------------------------

describe('replay load - tool name validation', () => {
  it('rejects a sequence with an unknown tool name when the provider is supplied', async () => {
    const { replay, recorder } = makeReplay(
      seq([{ tool: 'navigate', params: {} }, { tool: 'inpsect', params: {} }]),
      () => KNOWN_TOOLS
    );

    const res = await replay.handler({ action: 'load', filename: 'x.json' } as any);

    expect(res.isError).toBe(true);
    expect(text(res)).toContain('Step 2');
    expect(text(res)).toContain('inpsect');
    expect(text(res)).toContain('inspect');
    // sequence must not linger in memory where it could still be run by id
    expect(recorder.deleteSequence).toHaveBeenCalledWith('seq-1');
    // and nothing was pushed into history
    expect(recorder.recordCommand).not.toHaveBeenCalled();
  });

  it('rejects before loading into history when intoHistory is set', async () => {
    const { replay, recorder } = makeReplay(
      seq([{ tool: 'bogus', params: {} }]),
      () => KNOWN_TOOLS
    );

    const res = await replay.handler({ action: 'load', filename: 'x.json', intoHistory: true } as any);

    expect(res.isError).toBe(true);
    expect(recorder.recordCommand).not.toHaveBeenCalled();
  });

  it('loads a valid sequence normally', async () => {
    const { replay, recorder } = makeReplay(
      seq([{ tool: 'navigate', params: {} }, { tool: 'conditional', params: {} }]),
      () => KNOWN_TOOLS
    );

    const res = await replay.handler({ action: 'load', filename: 'x.json' } as any);

    expect(res.isError).toBeUndefined();
    expect(recorder.deleteSequence).not.toHaveBeenCalled();
  });

  it('does not validate when no tool-name provider is supplied (previous behaviour)', async () => {
    const { replay, recorder } = makeReplay(seq([{ tool: 'inpsect', params: {} }]));

    const res = await replay.handler({ action: 'load', filename: 'x.json' } as any);

    expect(res.isError).toBeUndefined();
    expect(recorder.deleteSequence).not.toHaveBeenCalled();
  });

  it('does not validate when the provider returns an empty list', async () => {
    const { replay } = makeReplay(seq([{ tool: 'inpsect', params: {} }]), () => []);

    const res = await replay.handler({ action: 'load', filename: 'x.json' } as any);

    expect(res.isError).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe('replay create - tool name validation', () => {
  it('rejects a created sequence containing an unknown tool name', async () => {
    const { replay, recorder } = makeReplay(
      seq([{ tool: 'ntavigate', params: {} }], 'from-history'),
      () => KNOWN_TOOLS
    );

    const res = await replay.handler({ action: 'create', name: 'from-history', indices: [0] } as any);

    expect(res.isError).toBe(true);
    expect(text(res)).toContain('Step 1');
    expect(text(res)).toContain('ntavigate');
    // Rejected before storage, so there is nothing to clean up afterwards
    expect(recorder.deleteSequence).not.toHaveBeenCalled();
  });

  it('creates a valid sequence normally', async () => {
    const { replay, recorder } = makeReplay(
      seq([{ tool: 'navigate', params: {} }], 'from-history'),
      () => KNOWN_TOOLS
    );

    const res = await replay.handler({ action: 'create', name: 'from-history', indices: [0] } as any);

    expect(res.isError).toBeUndefined();
    expect(recorder.deleteSequence).not.toHaveBeenCalled();
  });

  it('does not validate when no tool-name provider is supplied', async () => {
    const { replay } = makeReplay(seq([{ tool: 'ntavigate', params: {} }], 'from-history'));

    const res = await replay.handler({ action: 'create', name: 'from-history', indices: [0] } as any);

    expect(res.isError).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// create ordering: validation must run before the same-name replace
// ---------------------------------------------------------------------------

describe('replay create - a rejected create must not destroy the existing sequence', () => {
  async function realRecorderReplay() {
    const recorder = new CommandRecorder();
    await recorder.recordCommand('navigate', { action: 'goto', url: 'http://example.test/' });
    await recorder.recordCommand('ntavigate', { action: 'goto', url: 'http://example.test/bad' });
    const { replay } = createReplayTools(recorder, vi.fn(), undefined, undefined, () => KNOWN_TOOLS);
    return { recorder, replay };
  }

  it('keeps the good in-memory sequence when a same-named create is rejected', async () => {
    const { recorder, replay } = await realRecorderReplay();

    const good = await replay.handler({ action: 'create', name: 'login', indices: [0] } as any);
    expect(good.isError).toBeUndefined();
    const goodId = recorder.listSequences()[0].id;

    const bad = await replay.handler({ action: 'create', name: 'login', indices: [1] } as any);
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain('ntavigate');

    // the original survives, unchanged, under the same id - and nothing else was stored
    const remaining = recorder.listSequences();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(goodId);
    expect(remaining[0].commands.map(c => c.tool)).toEqual(['navigate']);
  });

  it('still resolves the pre-existing sequence by name after a rejected create', async () => {
    const { replay } = await realRecorderReplay();

    await replay.handler({ action: 'create', name: 'login', indices: [0] } as any);
    await replay.handler({ action: 'create', name: 'login', indices: [1] } as any);

    const got = await replay.handler({ action: 'get', name: 'login' } as any);
    expect(got.isError).toBeUndefined();
    expect(text(got)).toContain('navigate');
    expect(text(got)).not.toContain('ntavigate');
  });

  it('replaces the existing sequence when the new one is valid (dedupe still works, #75)', async () => {
    const { recorder, replay } = await realRecorderReplay();
    await recorder.recordCommand('inspect', { action: 'evaluateExpression', expression: '1+1' });

    await replay.handler({ action: 'create', name: 'login', indices: [0] } as any);
    const res = await replay.handler({ action: 'create', name: 'login', indices: [0, 2] } as any);

    expect(res.isError).toBeUndefined();
    const remaining = recorder.listSequences();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].commands.map(c => c.tool)).toEqual(['navigate', 'inspect']);
  });
});
