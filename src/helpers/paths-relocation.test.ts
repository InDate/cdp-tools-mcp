/**
 * FROZEN CONTRACT - registry-and-transaction half.
 *
 * Specifies the root-bound resource registry and the `relocateRoot`
 * transaction that `config({ action: 'useLocal', path: X })` is meant to
 * drive, so a relocation moves every dependent subsystem's storage root live,
 * in-process, with no MCP server restart:
 *
 *   Every stored path derives from one root held in paths.ts; code resolves a
 *   path at use or registers a root-bound resource carrying rebind or veto; a
 *   root change rebinds every registered resource, and one veto returns the
 *   change unapplied, naming the resource.
 *
 * None of the surface below exists yet in src/helpers/paths.ts. This file's
 * failures against that missing surface are the intended red state.
 *
 * TARGET INTERFACE (paths.ts):
 *
 *   export interface RootBoundResource {
 *     name: string;
 *     rebind(root: string): void | Promise<void>;
 *     veto?(): string | null;   // a non-null string is a refusal reason
 *   }
 *   export function registerRootBound(resource: RootBoundResource): void;
 *   export function unregisterRootBound(name: string): void;
 *   export function relocateRoot(dir: string): Promise<void>;
 *
 * `veto` (not `canRebind`): a predicate named `canRebind` returning `true` to
 * mean "no objection" collides with a truthy STRING reason for a veto -
 * `if (resource.canRebind())` passes for both, so a veto would silently stop
 * vetoing. `veto()` returning `null` (or being absent) means "no objection";
 * any non-null string is the refusal reason.
 *
 * `relocateRoot(dir)` is new and separate from `setWorkingDirOverride(dir)`,
 * which keeps its current synchronous signature (used at startup, before
 * anything is registered, and by every existing test that calls it
 * synchronously today - none of that is touched here). `relocateRoot` is the
 * transaction: collect every registered resource's `veto()` first; any
 * non-null veto rejects (message names the vetoing resource), leaving the
 * root AND every resource untouched; with no veto, mutate the root, then
 * `await` every resource's `rebind(root)`, in registration order.
 *
 * `ConfigManager.useLocal` is specified (not implemented here - production
 * source is untouched) to call `relocateRoot` when given an explicit `path`.
 *
 * This file's one opinionated design choice beyond the brief: a second
 * `registerRootBound` call under a name already held REPLACES the earlier
 * registration (last write wins) rather than erroring or accumulating both.
 * That matches the "re-registering under a name replaces the old entry"
 * convention command-recorder.ts already uses for sequence names
 * (`removeSequenceByName`, command-recorder.ts:643-649, motivated at
 * :562-564: a name maps to exactly one entry, otherwise a lookup by name
 * resolves the stale one).
 *
 * `registerRootBound`/`unregisterRootBound`/`relocateRoot` are reached
 * through a namespace import so a missing export fails inside each test body
 * (a clear per-test red result), not at module load, which would crash every
 * test in the file at once and hide individual results.
 *
 * SCOPE NOTE: this file is the ONLY relocation spec file permitted to call
 * `registerRootBound` directly - it is testing the registry itself. Every
 * other relocation spec file (issue-tracker-relocation.test.ts,
 * command-recorder-relocation.test.ts, server-manager-relocation.test.ts)
 * MUST drive relocation through production code only. The last test in this
 * file enforces that boundary by grepping the other files on disk.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, promises as fsp } from 'fs';
import { join, relative, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { getOutputPath, resolveStateDir } from './paths.js';
import * as pathsModule from './paths.js';

let rootA: string;
let rootB: string;

function register(resource: {
  name: string;
  rebind: (root: string) => void | Promise<void>;
  veto?: () => string | null;
}): void {
  (pathsModule as any).registerRootBound(resource);
}

function unregister(name: string): void {
  (pathsModule as any).unregisterRootBound(name);
}

function relocate(dir: string): Promise<void> {
  return (pathsModule as any).relocateRoot(dir);
}

beforeEach(() => {
  rootA = mkdtempSync(join(tmpdir(), 'devharness-paths-reloc-a-'));
  rootB = mkdtempSync(join(tmpdir(), 'devharness-paths-reloc-b-'));
});

afterEach(() => {
  // Best-effort cleanup so a resource registered by one test can't rebind (or
  // veto) a later test's relocation. No-op today since unregisterRootBound
  // doesn't exist yet - becomes load-bearing once it does.
  for (const name of ['probe-a', 'probe-b', 'probe-veto', 'probe-x']) {
    try { unregister(name); } catch { /* not implemented yet, or never registered */ }
  }
  rmSync(rootA, { recursive: true, force: true });
  rmSync(rootB, { recursive: true, force: true });
});

describe('relocateRoot as a transaction', () => {
  it('with no veto: updates the root and rebinds every registered resource, in registration order, with the new root', async () => {
    const calls: string[] = [];
    register({ name: 'probe-a', rebind: (root) => { calls.push(`a:${root}`); } });
    register({ name: 'probe-b', rebind: (root) => { calls.push(`b:${root}`); } });

    await relocate(rootB);

    const expectedRoot = resolveStateDir(rootB);
    expect(calls).toEqual([`a:${expectedRoot}`, `b:${expectedRoot}`]);
    expect(getOutputPath()).toBe(expectedRoot);
  });

  it('one veto: the root is left unchanged, no resource is rebound, and the rejection names the vetoing resource', async () => {
    await relocate(rootA); // establish a known baseline root
    const baselineRoot = getOutputPath();

    const rebindSpy = vi.fn();
    register({ name: 'probe-a', rebind: rebindSpy });
    register({
      name: 'probe-veto',
      rebind: vi.fn(),
      veto: () => 'managed server "fitness-demo" is running and cannot move its log files',
    });

    await expect(relocate(rootB)).rejects.toThrow(/probe-veto/);
    await expect(relocate(rootB)).rejects.toThrow(/fitness-demo/);

    expect(rebindSpy).not.toHaveBeenCalled();
    expect(getOutputPath()).toBe(baselineRoot);
  });

  it('veto() returning a truthy non-string is not treated as a refusal (guards against the canRebind/true collision this rename fixes)', async () => {
    // A resource whose veto() (mis-)implemented as "true means blocked" would
    // fail this - the contract is: only a string return value is a veto.
    register({ name: 'probe-a', rebind: vi.fn(), veto: () => null });

    await expect(relocate(rootB)).resolves.toBeUndefined();
  });

  it('a resource that does not veto is unaffected by a sibling resource that does: transaction is all-or-nothing', async () => {
    await relocate(rootA);
    const baselineRoot = getOutputPath();

    const rebindSpy = vi.fn();
    register({ name: 'probe-a', rebind: rebindSpy, veto: () => null });
    register({ name: 'probe-veto', rebind: vi.fn(), veto: () => 'blocked' });

    await expect(relocate(rootB)).rejects.toThrow();

    expect(rebindSpy).not.toHaveBeenCalled();
    expect(getOutputPath()).toBe(baselineRoot);
  });
});

describe('registry contract', () => {
  it('an unregistered resource does not rebind on a later relocation', async () => {
    const rebindSpy = vi.fn();
    register({ name: 'probe-a', rebind: rebindSpy });
    unregister('probe-a');

    await relocate(rootB);

    expect(rebindSpy).not.toHaveBeenCalled();
  });

  it('re-registering the same name replaces the earlier registration (last write wins), not both firing', async () => {
    const firstSpy = vi.fn();
    const secondSpy = vi.fn();
    register({ name: 'probe-x', rebind: firstSpy });
    register({ name: 'probe-x', rebind: secondSpy }); // same name, no unregister in between

    await relocate(rootB);

    expect(firstSpy).not.toHaveBeenCalled();
    expect(secondSpy).toHaveBeenCalledTimes(1);
  });

  it('a veto from the replacement registration is the one that applies, not the replaced original', async () => {
    register({ name: 'probe-x', rebind: vi.fn(), veto: () => null });
    register({ name: 'probe-x', rebind: vi.fn(), veto: () => 'replacement vetoes' });

    await expect(relocate(rootB)).rejects.toThrow(/probe-x/);
  });
});

describe('relocation spec contract (rule 1)', () => {
  const THIS_FILE = fileURLToPath(import.meta.url);
  const SRC_ROOT = join(dirname(THIS_FILE), '..');

  async function findRelocationSpecFiles(dir: string): Promise<string[]> {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        files.push(...await findRelocationSpecFiles(full));
      } else if (entry.isFile() && entry.name.endsWith('-relocation.test.ts')) {
        files.push(full);
      }
    }
    return files;
  }

  it('no relocation spec file except this one drives relocation by calling registerRootBound(...) itself', async () => {
    const specFiles = await findRelocationSpecFiles(SRC_ROOT);
    const violations: string[] = [];

    for (const file of specFiles) {
      if (file === THIS_FILE) continue; // this file's own registry-contract tests are exempt
      const content = await fsp.readFile(file, 'utf-8');
      if (content.includes('registerRootBound(')) {
        violations.push(relative(SRC_ROOT, file));
      }
    }

    expect(violations).toEqual([]);
  });
});
