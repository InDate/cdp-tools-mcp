/**
 * FROZEN CONTRACT - issue-tracker half.
 *
 * Specifies what `config({ action: 'useLocal', path: X })` must do to the
 * issue tracker's storage root, live, in-process, with no MCP server restart.
 *
 * BACKGROUND (why this exists): `checkBugBlocking` (src/tool-response.ts:364)
 * calls `hasPendingBugs()` on EVERY tool call, `config` included, BEFORE that
 * tool's own handler runs (index.ts:1683 vs :1702). `hasPendingBugs()` calls
 * `ensureIndexLoaded()` (issue-tracker.ts:538), a one-shot gate
 * (`if (index) return`, :539) that scans `getItemsDir()` and binds an
 * `fs.watch` to it ONCE per process. Nothing today invalidates that cache when
 * `useLocal path=X` moves the storage root - `issues list` keeps serving
 * whatever directory happened to be current the first time ANY tool call
 * touched the tracker, which in the reported incident was the pre-relocation
 * root, by then emptied by a manual file move.
 *
 * TARGET DESIGN: issue-tracker.ts registers a `RootBoundResource` (see
 * src/helpers/paths-relocation.test.ts for that registry's own contract)
 * whose `rebind()` closes the current watcher, drops the in-memory index, and
 * lets the next read rescan `getItemsDir()` - which by then resolves under
 * the new root because `relocateRoot` mutates the root before calling any
 * `rebind`.
 *
 * RULE (imposed by the coordinator on this revision): a test in this file
 * must NOT call `registerRootBound` itself - simulating the module's own
 * production registration in-test would make these tests validate registry
 * mechanics while leaving the actual bug (the index staying pinned to the old
 * root) able to survive a green suite. Every test here drives relocation
 * through `relocateRoot` (the production transaction, paths.ts) or
 * `ConfigManager.useLocal` (the MCP-facing entry point, config.ts) only, and
 * only imports and calls issue-tracker.ts's own real functions
 * (`getIssues`, `addIssue`, `hasPendingBugs`, `getIssueItemsDir`,
 * `__resetForTests`). `paths-relocation.test.ts`'s own registry-contract
 * tests are the only ones exempt from this rule.
 *
 * Reached through namespace imports so a missing export fails inside each
 * test body (a clear per-test red result), not at module load - which would
 * crash every test in the file at once and hide individual results.
 *
 * FAILURE CLASSES a test in this file can show, in the order a real build
 * would retire them:
 *   1. "missing export"  - `relocateRoot` (or the registry it depends on)
 *      does not exist in paths.ts yet. Surfaces as a thrown TypeError before
 *      any assertion runs. This is everything's current state - paths.ts has
 *      none of this surface today.
 *   2. "missing wiring"  - `relocateRoot` exists and runs to completion
 *      (no veto, since nothing has registered), but issue-tracker.ts never
 *      registered a resource, so nothing rebinds. Surfaces as a normal
 *      assertion failure (stale data), not a crash - it can only be observed
 *      once class 1 is fixed, so it is not separately reproducible today.
 *   3. "useLocal does not forward" - `relocateRoot` and issue-tracker's
 *      wiring both work, but `ConfigManager.useLocal` was never updated to
 *      call `relocateRoot`, so it silently keeps running its old
 *      `setWorkingDirOverride`-only behavior. Only the one test that drives
 *      relocation through `ConfigManager.useLocal` (marked below) can show
 *      this class; right now it manifests exactly like class 1/2 (an
 *      assertion failure, because `useLocal` throws nothing either way).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setWorkingDirOverride } from './helpers/paths.js';
import * as pathsModule from './helpers/paths.js';
import { ConfigManager } from './config.js';
import {
  __resetForTests,
  addIssue,
  getIssues,
  getIssueItemsDir,
  hasPendingBugs,
} from './issue-tracker.js';

let rootA: string;
let rootB: string;

function relocate(dir: string): Promise<void> {
  return (pathsModule as any).relocateRoot(dir);
}

beforeEach(async () => {
  rootA = await fsp.mkdtemp(join(tmpdir(), 'devharness-it-reloc-a-'));
  rootB = await fsp.mkdtemp(join(tmpdir(), 'devharness-it-reloc-b-'));
  setWorkingDirOverride(rootA);
  __resetForTests();
});

afterEach(async () => {
  __resetForTests();
  await fsp.rm(rootA, { recursive: true, force: true });
  await fsp.rm(rootB, { recursive: true, force: true });
});

function issueFrontmatter(id: number, type: 'bug' | 'feature', title: string): string {
  return [
    '---',
    `id: ${id}`,
    `type: ${type}`,
    'status: pending',
    `title: "${title}"`,
    'reportedAt: 2026-01-01T00:00:00.000Z',
    '---',
    '',
    'Body.',
    '',
  ].join('\n');
}

describe('relocateRoot: issue-tracker index (scenario a)', () => {
  it('reflects X\'s items dir after relocateRoot(X), even though the index was primed from A first (the reported scenario)', async () => {
    // Prime the in-memory index/watcher from root A, exactly like
    // checkBugBlocking's hasPendingBugs() does on every tool call before a
    // handler ever runs (index.ts:1683).
    await hasPendingBugs();

    // Root B already has issues on disk - as if created by another process,
    // or manually moved there, before relocation ever ran.
    const itemsDirB = join(rootB, '.devharness', 'issues', 'items');
    await fsp.mkdir(itemsDirB, { recursive: true });
    await fsp.writeFile(join(itemsDirB, 'feature-001-first.md'), issueFrontmatter(1, 'feature', 'First'), 'utf-8');
    await fsp.writeFile(join(itemsDirB, 'feature-002-second.md'), issueFrontmatter(2, 'feature', 'Second'), 'utf-8');

    await relocate(rootB);

    const issues = await getIssues();
    expect(issues.map(i => i.id).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(issues.map(i => i.title).sort()).toEqual(['First', 'Second']);
  });
});

describe('relocateRoot: issue numbering (scenario b)', () => {
  it('a created issue after relocation numbers after what already exists on disk at X (collision case: feature-001 pre-exists at X)', async () => {
    const itemsDirB = join(rootB, '.devharness', 'issues', 'items');
    await fsp.mkdir(itemsDirB, { recursive: true });
    await fsp.writeFile(join(itemsDirB, 'feature-001-existing.md'), issueFrontmatter(1, 'feature', 'Existing'), 'utf-8');

    await relocate(rootB);

    const created = await addIssue({ type: 'feature', title: 'New after relocation' });

    // Must not restart numbering from 1 - that would collide with the
    // feature-001 file already on disk at X.
    expect(created.id).toBe(2);

    const items = await fsp.readdir(itemsDirB);
    expect(items.filter(f => f.startsWith('feature-001-'))).toHaveLength(1);
    expect(items.some(f => f.startsWith('feature-002-'))).toBe(true);
  });
});

describe('relocateRoot: fs.watch rebind (scenario c)', () => {
  it('a file added to X/items after relocation appears in the index', async () => {
    await hasPendingBugs(); // prime from A first, as in the reported scenario

    await relocate(rootB);

    const itemsDirB = getIssueItemsDir();
    expect(itemsDirB.startsWith(rootB)).toBe(true);

    await fsp.mkdir(itemsDirB, { recursive: true });
    await fsp.writeFile(
      join(itemsDirB, 'feature-007-external.md'),
      issueFrontmatter(7, 'feature', 'External after relocation'),
      'utf-8'
    );

    // Wait past the watcher's debounce window (250ms, issue-tracker.ts's
    // RELOAD_DEBOUNCE_MS) - same margin issue-tracker.test.ts's own
    // "picks up an externally-written issue file" case uses.
    await new Promise(resolve => setTimeout(resolve, 500));

    const issues = await getIssues();
    expect(issues.some(i => i.id === 7 && i.title === 'External after relocation')).toBe(true);
  });
});

describe('relocateRoot: ordering independence (scenario f, simulated)', () => {
  it('[ordering, simulated] a checkBugBlocking-style priming call against A does not pin the index to A once relocateRoot(B) runs', async () => {
    // This simulates, rather than drives through the real MCP
    // CallToolRequestSchema pipeline, the ordering index.ts actually produces
    // on every tool call: index.ts:1683 runs checkBugBlocking() ->
    // hasPendingBugs() BEFORE index.ts:1702 runs the tool's own handler - and
    // this happens even when the tool call IS `config` itself, since
    // checkBugBlocking has no `toolName !== 'config'` exemption (unlike
    // index.ts:1599 and :1604). Driving the actual handler in-process would
    // require constructing a full MCP server instance (chromeLauncher,
    // connectionManager, serverManager, commandRecorder, startupGate, ...),
    // which no existing test does; this reproduces the same two-call
    // ordering directly instead. Under the registry design this ordering
    // should stop mattering: rebind happens inside relocateRoot's own
    // transaction, not depending on nothing having touched the tracker
    // beforehand.
    await hasPendingBugs(); // the checkBugBlocking-triggered priming call, against A

    const itemsDirB = join(rootB, '.devharness', 'issues', 'items');
    await fsp.mkdir(itemsDirB, { recursive: true });
    await fsp.writeFile(join(itemsDirB, 'feature-009-ordering.md'), issueFrontmatter(9, 'feature', 'Ordering case'), 'utf-8');

    await relocate(rootB); // the tool's own handler, running after the priming call above

    const issues = await getIssues();
    expect(issues.some(i => i.id === 9 && i.title === 'Ordering case')).toBe(true);
  });
});

describe('ConfigManager.useLocal forwards to relocateRoot (extra coverage, not part of scenarios a-e)', () => {
  it('[useLocal end-to-end] useLocal(path=X) alone reproduces the reported bug fix - it must not be possible to pass every other test here while useLocal itself still only calls the old setWorkingDirOverride', async () => {
    // This is the one test in this file driven through ConfigManager.useLocal
    // rather than relocateRoot directly - closing the loop the coordinator's
    // rule 3 specifies ("ConfigManager.useLocal is specified to call
    // relocateRoot") but that no other test here exercises, since every
    // other test intentionally calls relocateRoot directly to isolate
    // registry/wiring failures from a config.ts forwarding bug. Today this
    // fails as a plain assertion mismatch: config.ts's useLocal still only
    // calls the old (unrelocated) setWorkingDirOverride, so it throws
    // nothing - the relocation silently does not happen.
    await hasPendingBugs();

    const itemsDirB = join(rootB, '.devharness', 'issues', 'items');
    await fsp.mkdir(itemsDirB, { recursive: true });
    await fsp.writeFile(join(itemsDirB, 'feature-011-useLocal.md'), issueFrontmatter(11, 'feature', 'Via useLocal'), 'utf-8');

    const manager = new ConfigManager();
    await manager.useLocal(false, rootB);

    const issues = await getIssues();
    expect(issues.some(i => i.id === 11 && i.title === 'Via useLocal')).toBe(true);
  });
});
