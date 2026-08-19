/**
 * FROZEN CONTRACT - command-recorder half.
 *
 * Specifies that `config({ action: 'useLocal', path: X })` must rebind
 * CommandRecorder's sequence-file watcher to X's sequences dir, live,
 * in-process, with no MCP server restart.
 *
 * `CommandRecorder.startSequenceWatch()` (src/command-recorder.ts:217-239)
 * already recomputes its target directories fresh from `getSequencesDir()`
 * (itself a fresh `getOutputPath()` call, :200-202) and replaces the watcher
 * wholesale each time it runs - so it is already "relocation-safe" IF called
 * again after the root moves. Nothing calls it again today: it only runs once
 * at server startup (index.ts:1949) and from the recorder's own internal
 * save/load paths.
 *
 * TARGET DESIGN: command-recorder.ts registers a `RootBoundResource` (see
 * src/helpers/paths-relocation.test.ts for that registry's own contract)
 * whose `rebind()` re-invokes the already-existing `startSequenceWatch()`.
 *
 * RULE (imposed by the coordinator on this revision): this test must NOT
 * call `registerRootBound` itself - simulating command-recorder.ts's own
 * production registration in-test would validate registry mechanics while
 * leaving the actual wiring gap able to survive a green suite. It drives
 * relocation through `relocateRoot` (the production transaction, paths.ts)
 * only, and only calls CommandRecorder's own real, already-existing public
 * methods (`startSequenceWatch`, `getWatchedDirs`, `stopSequenceWatch`).
 *
 * `relocateRoot` is reached through a namespace import so a missing export
 * fails inside the test body, not at module load.
 *
 * FAILURE CLASSES this test can show, in the order a real build would retire
 * them (see issue-tracker-relocation.test.ts's header for the fuller
 * explanation of both):
 *   1. "missing export"  - `relocateRoot` does not exist in paths.ts yet.
 *      Surfaces as a thrown TypeError. This is today's actual state.
 *   2. "missing wiring"  - `relocateRoot` exists and runs to completion, but
 *      command-recorder.ts never registered a resource, so
 *      `startSequenceWatch()` is never re-invoked and the watcher stays
 *      bound to the old root. Surfaces as a plain assertion failure
 *      (`getWatchedDirs()` still lists A, not B) once class 1 is fixed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { setWorkingDirOverride, resolveStateDir } from './helpers/paths.js';
import * as pathsModule from './helpers/paths.js';
import { CommandRecorder } from './command-recorder.js';

let rootA: string;
let rootB: string;
let recorder: CommandRecorder;

function relocate(dir: string): Promise<void> {
  return (pathsModule as any).relocateRoot(dir);
}

beforeEach(() => {
  rootA = mkdtempSync(join(tmpdir(), 'devharness-cr-reloc-a-'));
  rootB = mkdtempSync(join(tmpdir(), 'devharness-cr-reloc-b-'));
});

afterEach(() => {
  recorder?.stopSequenceWatch();
  rmSync(rootA, { recursive: true, force: true });
  rmSync(rootB, { recursive: true, force: true });
});

describe('relocateRoot: command-recorder sequence watcher (scenario d)', () => {
  it('serves X\'s sequences dir after relocateRoot(X), not the root it started on', async () => {
    setWorkingDirOverride(rootA);
    recorder = new CommandRecorder();
    recorder.startSequenceWatch(); // as index.ts:1949 does once at startup, against rootA

    await relocate(rootB);

    const expectedSequencesDirB = join(resolveStateDir(rootB), 'sequences');
    const expectedSequencesDirA = join(resolveStateDir(rootA), 'sequences');

    expect(recorder.getWatchedDirs().some(d => d === expectedSequencesDirB)).toBe(true);
    expect(recorder.getWatchedDirs().some(d => d === expectedSequencesDirA)).toBe(false);
  });
});
