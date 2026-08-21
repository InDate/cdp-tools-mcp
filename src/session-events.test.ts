/**
 * Tests for the per-session event stream.
 *
 * The property worth pinning is that every kind lands in one file: a session
 * arms one watch, and a kind added later arrives on it without a second one.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initializePaths, setWorkingDirOverride, getOutputPath } from './helpers/paths.js';
import {
  appendEvent,
  getEventStreamPath,
  getEventsDir,
} from './session-events.js';

let dir: string;
let previousDir: string | undefined;

const SESSION = 'aaaaaaaa';

function readStream(): Array<Record<string, unknown>> {
  const path = getEventStreamPath(SESSION);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line));
}

beforeEach(() => {
  previousDir = process.env.DEVHARNESS_DIR;
  dir = mkdtempSync(join(tmpdir(), 'devharness-events-'));
  process.env.DEVHARNESS_DIR = dir;
  initializePaths();
});

afterEach(() => {
  if (previousDir === undefined) delete process.env.DEVHARNESS_DIR;
  else process.env.DEVHARNESS_DIR = previousDir;
  initializePaths();
  rmSync(dir, { recursive: true, force: true });
});

describe('appendEvent', () => {
  it('writes one line per event, each stamped and kinded', async () => {
    await appendEvent(SESSION, 'block', { guard: 'port', tool: 'navigate' });
    await appendEvent(SESSION, 'message', { from: 'bbbbbbbb' });

    const events = readStream();
    expect(events.map(e => e.kind)).toEqual(['block', 'message']);
    expect(events[0]).toMatchObject({ kind: 'block', guard: 'port', tool: 'navigate' });
    expect(typeof events[0].ts).toBe('string');
  });

  it('puts every kind in the one file, so one watch covers them all', async () => {
    await appendEvent(SESSION, 'block', {});
    await appendEvent(SESSION, 'message', {});
    await appendEvent(SESSION, 'block', {});

    expect(getEventStreamPath(SESSION)).toBe(join(getEventsDir(), 'aaaaaaaa.jsonl'));
    expect(readStream()).toHaveLength(3);
  });
});
