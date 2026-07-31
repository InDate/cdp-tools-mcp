/**
 * A sequence edited on disk is picked up, the way a managed dev server picks
 * up its own sources.
 *
 * In-memory copies used to shadow the file for the whole session: you edited a
 * sequence, ran it by name, and got the previous version, with nothing in the
 * output to say so - while `runAll` reloaded the tree first and therefore ran
 * the NEW one, so the same sequence behaved differently depending on how it was
 * invoked (issue #134).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CommandRecorder } from '../command-recorder.js';
import { loadSequence } from './replay-executor.js';

let dir: string;
let recorder: CommandRecorder;
let file: string;

const write = async (selector: string) => {
  await fs.writeFile(file, JSON.stringify({
    id: 'seq-edit-me',
    name: 'edit-me',
    createdAt: 1,
    commands: [{ tool: 'dom', params: { action: 'querySelector', selector } }],
  }, null, 2));
};

const selectorOf = (sequence: any) => sequence.commands[0].params.selector;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'cdp-seq-reload-'));
  recorder = new CommandRecorder();
  file = join(dir, 'edit-me.json');
  await write('#before');
});

afterEach(async () => {
  recorder.stopSequenceWatch();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('a sequence edited on disk', () => {
  it('is re-read when it is run by name', async () => {
    const loaded = await recorder.loadSequenceFromDisk(file);
    expect(selectorOf(loaded)).toBe('#before');

    await write('#after');

    const result = await loadSequence({ name: 'edit-me' }, recorder);
    expect(result.success).toBe(true);
    expect(selectorOf((result as any).sequence)).toBe('#after');
  });

  it('is re-read when it is run by id', async () => {
    await recorder.loadSequenceFromDisk(file);
    await write('#after');

    const result = await loadSequence({ sequenceId: 'seq-edit-me' }, recorder);
    expect(selectorOf((result as any).sequence)).toBe('#after');
  });

  it('leaves the loaded copy alone while the file is half-written', async () => {
    await recorder.loadSequenceFromDisk(file);
    await fs.writeFile(file, '{ "name": "edit-me", "comm');

    const result = await loadSequence({ name: 'edit-me' }, recorder);
    // Better a known-good sequence than none: a watcher fires mid-write as
    // readily as after one.
    expect(selectorOf((result as any).sequence)).toBe('#before');
  });

  it('is picked up by the watcher without anyone asking', async () => {
    await recorder.loadSequenceFromDisk(file);
    recorder.startSequenceWatch();

    await write('#after');

    // The watcher debounces 400ms, and fs events are not instant under load.
    await vi.waitFor(() => {
      const inMemory = recorder.listSequences().find(s => s.name === 'edit-me');
      expect(selectorOf(inMemory)).toBe('#after');
    }, { timeout: 5000, interval: 50 });
  });
});

describe('a sequence built from history', () => {
  it('is not touched by the reload path - it exists nowhere else', async () => {
    await recorder.recordCommand('dom', { action: 'querySelector', selector: '#from-history' });
    const created = await recorder.createSequence('memory-only', [0]);

    expect(await recorder.reloadChangedSequences()).toEqual([]);
    const result = await loadSequence({ sequenceId: created!.id }, recorder);
    expect(selectorOf((result as any).sequence)).toBe('#from-history');
  });
});
