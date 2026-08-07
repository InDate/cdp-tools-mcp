/**
 * `addConditional` is the only authoring route for `conditional` steps, which
 * are virtual and therefore never recorded.
 */
import { describe, it, expect, vi } from 'vitest';
import { createReplayTools } from './replay-tools.js';
import { validateConditionSyntax } from './replay-executor.js';
import type { CommandSequence, RecordedCommand } from '../command-recorder.js';

const seq = (name: string, commands: RecordedCommand[] = []): CommandSequence => ({
  id: `id-${name}`,
  name,
  commands,
  createdAt: 1,
});

function makeReplay(options?: {
  sequences?: CommandSequence[];
  onDisk?: Array<{ name: string; location: string }>;
  saveResult?: any;
}) {
  const sequences = options?.sequences ?? [seq('main', [{ tool: 'navigate', params: {} }])];
  const recorder = {
    listSequences: vi.fn(() => sequences),
    getSequence: vi.fn((id: string) => sequences.find(s => s.id === id)),
    getFreshSequence: vi.fn(async (id: string) => sequences.find(s => s.id === id)),
    loadSequenceFromDisk: vi.fn(async () => null),
    listSavedSequencesOnDisk: vi.fn(async () => options?.onDisk ?? []),
    saveSequenceToDisk: vi.fn(async () => options?.saveResult ?? null),
    recordCommand: vi.fn(),
  } as any;
  const { replay } = createReplayTools(recorder, vi.fn());
  return { recorder, replay, sequences };
}

const call = (replay: any, args: any) => replay.handler(args);
const text = (res: any) => res.content[0].text as string;

describe('validateConditionSyntax', () => {
  it('accepts every supported condition type', () => {
    for (const c of [
      '{{selector:.banner}}',
      '{{!selector:.banner}}',
      '{{url:contains:/app}}',
      '{{url:matches:^https://.*}}',
      '{{cookie:session}}',
      '{{localStorage:token}}',
      '{{indexedDB:db/store}}',
      '{{indexedDB:db/store/key}}',
    ]) {
      expect(validateConditionSyntax(c), c).toEqual({ ok: true });
    }
  });

  it('rejects a bare condition with no handlebars', () => {
    const result = validateConditionSyntax('.banner');
    expect(result).toMatchObject({ ok: false });
    expect((result as any).reason).toContain('Invalid condition format');
  });

  it('rejects an unknown condition type', () => {
    const result = validateConditionSyntax('{{title:Home}}');
    expect((result as any).reason).toContain('Unknown condition type');
  });

  it('rejects an uncompilable url regex', () => {
    const result = validateConditionSyntax('{{url:matches:([}}');
    expect(result.ok).toBe(false);
  });

  it('rejects a regex over the configured length cap', () => {
    const result = validateConditionSyntax(`{{url:matches:${'a'.repeat(20)}}}`, 5);
    expect((result as any).reason).toContain('too long');
  });

  it('rejects an indexedDB condition missing its store', () => {
    expect(validateConditionSyntax('{{indexedDB:db}}').ok).toBe(false);
  });

  it('leaves interpolated values alone - they are substituted at run time', () => {
    expect(validateConditionSyntax('{{indexedDB:db/store/{{var:id}}}}')).toEqual({ ok: true });
    expect(validateConditionSyntax('{{url:matches:^{{var:origin}}/([}}')).toEqual({ ok: true });
  });
});

describe('replay addConditional', () => {
  it('appends a conditional step with if/then params', async () => {
    const { replay, sequences } = makeReplay({
      sequences: [seq('main', [{ tool: 'navigate', params: {} }]), seq('dismiss-banner')],
    });

    const res = await call(replay, {
      action: 'addConditional',
      name: 'main',
      condition: '{{selector:.cookie-banner}}',
      thenSequence: 'dismiss-banner',
    });

    expect(res.isError).toBeFalsy();
    expect(sequences[0].commands).toEqual([
      { tool: 'navigate', params: {} },
      { tool: 'conditional', params: { if: '{{selector:.cookie-banner}}', then: 'dismiss-banner' } },
    ]);
    expect(text(res)).toContain('**Step 2** of 2');
  });

  it('inserts at insertAfterStep rather than appending', async () => {
    const { replay, sequences } = makeReplay({
      sequences: [
        seq('main', [{ tool: 'navigate', params: {} }, { tool: 'input', params: {} }]),
        seq('setup'),
      ],
    });

    await call(replay, {
      action: 'addConditional',
      name: 'main',
      condition: '{{!localStorage:token}}',
      thenSequence: 'setup',
      insertAfterStep: 0,
    });

    expect(sequences[0].commands.map(c => c.tool)).toEqual(['conditional', 'navigate', 'input']);
  });

  it('rejects insertAfterStep past the end of the sequence', async () => {
    const { replay, sequences } = makeReplay({
      sequences: [seq('main', [{ tool: 'navigate', params: {} }]), seq('setup')],
    });

    const res = await call(replay, {
      action: 'addConditional',
      name: 'main',
      condition: '{{cookie:session}}',
      thenSequence: 'setup',
      insertAfterStep: 5,
    });

    expect(res.isError).toBe(true);
    expect(sequences[0].commands).toHaveLength(1);
  });

  it('rejects an invalid condition before mutating the sequence', async () => {
    const { replay, sequences } = makeReplay({
      sequences: [seq('main'), seq('setup')],
    });

    const res = await call(replay, {
      action: 'addConditional',
      name: 'main',
      condition: 'cookie-banner-exists',
      thenSequence: 'setup',
    });

    expect(res.isError).toBe(true);
    expect(text(res)).toContain('Invalid condition format');
    expect(sequences[0].commands).toHaveLength(0);
  });

  it('rejects a branch target that does not exist', async () => {
    const { replay, sequences } = makeReplay({ sequences: [seq('main')] });

    const res = await call(replay, {
      action: 'addConditional',
      name: 'main',
      condition: '{{selector:.x}}',
      thenSequence: 'typo-sequence',
    });

    expect(res.isError).toBe(true);
    expect(text(res)).toContain('typo-sequence');
    expect(sequences[0].commands).toHaveLength(0);
  });

  it('accepts a branch target that only exists on disk', async () => {
    const { replay, sequences } = makeReplay({
      sequences: [seq('main')],
      onDisk: [{ name: 'dismiss-banner', location: 'working-dir' }],
    });

    const res = await call(replay, {
      action: 'addConditional',
      name: 'main',
      condition: '{{selector:.x}}',
      thenSequence: 'dismiss-banner',
    });

    expect(res.isError).toBeFalsy();
    expect(sequences[0].commands).toHaveLength(1);
  });

  it('rejects a conditional branching to its own sequence', async () => {
    const { replay, sequences } = makeReplay({ sequences: [seq('main')] });

    const res = await call(replay, {
      action: 'addConditional',
      name: 'main',
      condition: '{{selector:.x}}',
      thenSequence: 'main',
    });

    expect(res.isError).toBe(true);
    expect(text(res)).toContain('maxConditionalDepth');
    expect(sequences[0].commands).toHaveLength(0);
  });

  it('re-persists a sequence that already exists on disk', async () => {
    const { replay, recorder } = makeReplay({
      sequences: [seq('main'), seq('setup')],
      onDisk: [{ name: 'main', location: 'global' }],
      saveResult: { success: true, filepath: '/home/u/.devharness/sequences/main.json' },
    });

    const res = await call(replay, {
      action: 'addConditional',
      name: 'main',
      condition: '{{selector:.x}}',
      thenSequence: 'setup',
    });

    // global: true, overwrite: true - the file it came from.
    expect(recorder.saveSequenceToDisk).toHaveBeenCalledWith('id-main', true, true);
    expect(text(res)).toContain('/home/u/.devharness/sequences/main.json');
  });

  it('tells the caller to export when the sequence is memory-only', async () => {
    const { replay, recorder } = makeReplay({ sequences: [seq('main'), seq('setup')] });

    const res = await call(replay, {
      action: 'addConditional',
      name: 'main',
      condition: '{{selector:.x}}',
      thenSequence: 'setup',
    });

    expect(recorder.saveSequenceToDisk).not.toHaveBeenCalled();
    expect(text(res)).toContain("action: 'export'");
  });

  it('requires condition and thenSequence', async () => {
    const { replay } = makeReplay();
    const noCondition = await call(replay, { action: 'addConditional', name: 'main', thenSequence: 'setup' });
    const noThen = await call(replay, { action: 'addConditional', name: 'main', condition: '{{selector:.x}}' });
    expect(noCondition.isError).toBe(true);
    expect(noThen.isError).toBe(true);
  });
});
