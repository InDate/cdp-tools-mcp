/**
 * FROZEN CONTRACT - server-manager half.
 *
 * Specifies that `config({ action: 'useLocal', path: X })` must refuse to
 * relocate while a managed dev server is running.
 *
 * A running NativeRunner has already opened its stdout/stderr file
 * descriptors against the OLD root (`fs.openSync` in `NativeRunner.start()`,
 * src/runners/native-runner.ts:156-157, targeting `getStdoutLogPath()`/
 * `getStderrLogPath()`, :67-73) - an OS-level fact no config change can
 * redirect. That server's log destination cannot rebind; the only correct
 * outcome is refusing the relocation entirely while it runs.
 *
 * TARGET DESIGN: the refusal is NOT a special case inside
 * `relocateRoot`/`ConfigManager.useLocal`. Starting a managed server is
 * expected to register a per-server `RootBoundResource` (named after the
 * server id, see src/helpers/paths-relocation.test.ts for that registry's
 * own contract) via `paths.ts`'s `registerRootBound`, whose `veto()` returns
 * a refusal reason while the server runs; stopping the server is expected to
 * `unregisterRootBound` it. The refuse-while-running behaviour then falls out
 * of the generic registry transaction, not a bespoke check in ServerManager
 * or ConfigManager.
 *
 * RULE (imposed by the coordinator on this revision): this test must NOT
 * call `registerRootBound` itself - simulating NativeRunner/ServerManager's
 * own production registration in-test would validate registry mechanics
 * while leaving the actual wiring gap able to survive a green suite. It
 * drives relocation through `relocateRoot` (the production transaction,
 * paths.ts) only, against a real `ServerManager` driving a real (trivial)
 * child process - the same style server-ownership.test.ts already uses for
 * ServerManager tests.
 *
 * `relocateRoot` is reached through a namespace import so a missing export
 * fails inside each test body, not at module load.
 *
 * FAILURE CLASSES these tests can show, in the order a real build would
 * retire them (see issue-tracker-relocation.test.ts's header for the fuller
 * explanation of both):
 *   1. "missing export"  - `relocateRoot` does not exist in paths.ts yet.
 *      Surfaces as a thrown TypeError. This is today's actual state.
 *   2. "missing wiring"  - `relocateRoot` exists and runs to completion, but
 *      NativeRunner/ServerManager never registered a per-server resource, so
 *      nothing vetoes and the relocation silently succeeds while the server
 *      is running. Surfaces as `expect(...).rejects.toThrow()` instead
 *      resolving - a plain assertion failure, once class 1 is fixed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setWorkingDirOverride, initializePaths, getOutputPath } from './helpers/paths.js';
import * as pathsModule from './helpers/paths.js';
import { ServerManager } from './server-manager.js';

let rootA: string;
let rootB: string;
let serverScript: string;
let originalGlobalDir: string | undefined;

function relocate(dir: string): Promise<void> {
  return (pathsModule as any).relocateRoot(dir);
}

beforeEach(() => {
  rootA = mkdtempSync(join(tmpdir(), 'devharness-sm-reloc-a-'));
  rootB = mkdtempSync(join(tmpdir(), 'devharness-sm-reloc-b-'));
  // Isolate the global store too (ServerManager.saveState() writes both
  // local and global servers.json unconditionally) so this test cannot touch
  // the developer's real ~/.devharness - same convention server-ownership.test.ts
  // uses.
  originalGlobalDir = process.env.CDP_TOOLS_DIR;
  process.env.CDP_TOOLS_DIR = join(rootA, '__global__');
  initializePaths();
  setWorkingDirOverride(rootA);

  serverScript = join(rootA, 'stay-alive.mjs');
  writeFileSync(serverScript, 'setInterval(() => {}, 60000);\n');
});

afterEach(async () => {
  if (originalGlobalDir === undefined) delete process.env.CDP_TOOLS_DIR;
  else process.env.CDP_TOOLS_DIR = originalGlobalDir;
  initializePaths();
  rmSync(rootA, { recursive: true, force: true });
  rmSync(rootB, { recursive: true, force: true });
}, 20000);

describe('relocateRoot: refuses while a managed server runs (scenario e)', () => {
  it('refuses relocation while a managed server is running, naming it in the error', async () => {
    const serverManager = new ServerManager();
    await serverManager.startServer({
      id: 'fitness-demo',
      command: `node ${serverScript}`,
      cwd: rootA,
      autoRun: false,
    });

    try {
      await expect(relocate(rootB)).rejects.toThrow(/fitness-demo/);

      // A refusal must be a true no-op: the storage root must still be A.
      expect(getOutputPath().startsWith(rootA)).toBe(true);
    } finally {
      await serverManager.stopAll();
    }
  }, 20000);

  it('allows relocation once the managed server has been stopped', async () => {
    const serverManager = new ServerManager();
    await serverManager.startServer({
      id: 'fitness-demo',
      command: `node ${serverScript}`,
      cwd: rootA,
      autoRun: false,
    });
    await serverManager.stopServer('fitness-demo');

    await expect(relocate(rootB)).resolves.toBeUndefined();
    expect(getOutputPath().startsWith(rootB)).toBe(true);
  }, 20000);
});
