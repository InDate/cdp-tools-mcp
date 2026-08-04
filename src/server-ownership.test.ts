/**
 * Ownership rules for shared dev servers, exercised through a real
 * ServerManager driving real (trivial) child processes.
 *
 * The rule under test is the one that decides whether a process lives or dies:
 * stop a server only when no live session other than this one claims it. These
 * cases are written so that a regression to "stop everything on the way out"
 * fails loudly - that behaviour would kill a dev server another editor window
 * is actively using (issue #139).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ServerManager } from './server-manager.js';
import { ServerClaimsStore } from './server-claims.js';
import { initializePaths } from './helpers/paths.js';
import { isProcessAlive } from './helpers/process-liveness.js';

let workDir: string;
let originalCwd: string;
let originalGlobalDir: string | undefined;
let serverScript: string;

/** Pretend process table: pid -> start time. Absent means dead. */
let live: Map<number, string>;

const OWN_SUPERVISOR = 1001;
const OTHER_SUPERVISOR = 2002;

function storeFor(supervisorPid: number) {
  return new ServerClaimsStore({
    supervisorPid,
    isAlive: (pid) => live.has(pid),
    startTimeReader: (pid) => live.get(pid) ?? '',
  });
}

async function waitForExit(pid: number, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

beforeEach(() => {
  originalCwd = process.cwd();
  workDir = mkdtempSync(join(tmpdir(), 'cdp-ownership-test-'));
  process.chdir(workDir);
  originalGlobalDir = process.env.CDP_TOOLS_DIR;
  process.env.CDP_TOOLS_DIR = join(workDir, 'global');
  initializePaths();

  live = new Map([
    [OWN_SUPERVISOR, 'start-own'],
    [OTHER_SUPERVISOR, 'start-other'],
  ]);

  // A server that just stays up until it is stopped.
  serverScript = join(workDir, 'stay-alive.mjs');
  writeFileSync(serverScript, 'setInterval(() => {}, 60000);\n');
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (originalGlobalDir === undefined) delete process.env.CDP_TOOLS_DIR;
  else process.env.CDP_TOOLS_DIR = originalGlobalDir;
  initializePaths();
  rmSync(workDir, { recursive: true, force: true });
});

async function startServer(manager: ServerManager, id: string): Promise<number> {
  const result = await manager.startServer({
    id,
    command: `node ${serverScript}`,
    cwd: workDir,
    autoRun: false,
  });
  return result.pid;
}

describe('stopOwnedServers', () => {
  it('stops a server no other session claims', async () => {
    const manager = new ServerManager(storeFor(OWN_SUPERVISOR));
    const pid = await startServer(manager, 'solo');

    const { stopped, keptForOthers } = await manager.stopOwnedServers();

    expect(stopped).toEqual(['solo']);
    expect(keptForOthers).toEqual([]);
    expect(await waitForExit(pid)).toBe(true);
  }, 20000);

  it('leaves a server another live session is also using', async () => {
    const manager = new ServerManager(storeFor(OWN_SUPERVISOR));
    const pid = await startServer(manager, 'shared');
    // A second window in the same project reattached to it.
    await storeFor(OTHER_SUPERVISOR).claim('shared', workDir, false);

    const { stopped, keptForOthers } = await manager.stopOwnedServers();

    expect(stopped).toEqual([]);
    expect(keptForOthers).toEqual(['shared']);
    expect(isProcessAlive(pid)).toBe(true);

    // Our claim is gone, so once the other session dies the server is
    // collectable rather than pinned forever.
    expect(storeFor(OWN_SUPERVISOR).readAll(false).map((e) => e.claim.supervisorPid)).toEqual([OTHER_SUPERVISOR]);

    await manager.stopAll();
  }, 20000);

  it('stops a server whose other claimant has died', async () => {
    const manager = new ServerManager(storeFor(OWN_SUPERVISOR));
    const pid = await startServer(manager, 'was-shared');
    await storeFor(OTHER_SUPERVISOR).claim('was-shared', workDir, false);

    live.delete(OTHER_SUPERVISOR); // that window closed

    const { stopped } = await manager.stopOwnedServers();

    expect(stopped).toEqual(['was-shared']);
    expect(await waitForExit(pid)).toBe(true);
  }, 20000);

  it('leaves a server claimed by a session whose pid was recycled', async () => {
    const manager = new ServerManager(storeFor(OWN_SUPERVISOR));
    const pid = await startServer(manager, 'shared');
    await storeFor(OTHER_SUPERVISOR).claim('shared', workDir, false);

    // Pid reused by an unrelated process: alive, but not the claimant. The
    // claim is void, so this session may stop the server.
    live.set(OTHER_SUPERVISOR, 'start-other-RECYCLED');

    const { stopped } = await manager.stopOwnedServers();
    expect(stopped).toEqual(['shared']);
    expect(await waitForExit(pid)).toBe(true);
  }, 20000);
});

describe('stopOwnedServers and session presence', () => {
  it('leaves a server alone while another window works in the same project', async () => {
    // The ordering claims cannot cover: the other session was open before the
    // server existed, so it never claimed it.
    const other = storeFor(OTHER_SUPERVISOR);
    await other.registerSession(workDir);

    const manager = new ServerManager(storeFor(OWN_SUPERVISOR));
    const pid = await startServer(manager, 'sibling-window');

    const { stopped, keptForOthers } = await manager.stopOwnedServers();

    expect(stopped).toEqual([]);
    expect(keptForOthers).toEqual(['sibling-window']);
    expect(isProcessAlive(pid)).toBe(true);

    await manager.stopAll();
    other.unregisterSession();
  }, 20000);

  it('stops it once that window has gone', async () => {
    const other = storeFor(OTHER_SUPERVISOR);
    await other.registerSession(workDir);

    const manager = new ServerManager(storeFor(OWN_SUPERVISOR));
    const pid = await startServer(manager, 'last-one-out');
    live.delete(OTHER_SUPERVISOR);

    const { stopped } = await manager.stopOwnedServers();

    expect(stopped).toEqual(['last-one-out']);
    expect(await waitForExit(pid)).toBe(true);
  }, 20000);
});

describe('startup collection of abandoned servers', () => {
  it('collects a server whose every claimant is gone', async () => {
    // A previous session started it and then vanished without stopping it -
    // the closed-window leak.
    const previous = new ServerManager(storeFor(OTHER_SUPERVISOR));
    const pid = await startServer(previous, 'left-running');
    live.delete(OTHER_SUPERVISOR);

    const fresh = new ServerManager(storeFor(OWN_SUPERVISOR));
    const result = await fresh.initialize();

    expect(result.collected).toEqual(['left-running']);
    expect(await waitForExit(pid)).toBe(true);
  }, 25000);

  it('recovers rather than collects a server another live session still claims', async () => {
    const previous = new ServerManager(storeFor(OTHER_SUPERVISOR));
    const pid = await startServer(previous, 'still-used');

    const fresh = new ServerManager(storeFor(OWN_SUPERVISOR));
    const result = await fresh.initialize();

    expect(result.collected).toEqual([]);
    expect(result.recovered).toContain('still-used');
    expect(isProcessAlive(pid)).toBe(true);

    await fresh.stopAll();
  }, 25000);

  it('does not collect an abandoned server while another window is in the project', async () => {
    const previous = new ServerManager(storeFor(OTHER_SUPERVISOR));
    const pid = await startServer(previous, 'left-running');
    live.delete(OTHER_SUPERVISOR);

    // A third window is open on this project and may be using it.
    const bystander = storeFor(3003);
    live.set(3003, 'start-bystander');
    await bystander.registerSession(workDir);

    const fresh = new ServerManager(storeFor(OWN_SUPERVISOR));
    const result = await fresh.initialize();

    expect(result.collected).toEqual([]);
    expect(isProcessAlive(pid)).toBe(true);

    await fresh.stopAll();
    bystander.unregisterSession();
  }, 25000);

  it('leaves a server with no claim at all alone', async () => {
    // Started before claims existed, or by something else entirely. Not ours
    // to kill on a guess.
    const previous = new ServerManager(storeFor(OTHER_SUPERVISOR));
    const pid = await startServer(previous, 'unclaimed');
    storeFor(OTHER_SUPERVISOR).release('unclaimed', false);
    live.delete(OTHER_SUPERVISOR);

    const fresh = new ServerManager(storeFor(OWN_SUPERVISOR));
    const result = await fresh.initialize();

    expect(result.collected).toEqual([]);
    expect(isProcessAlive(pid)).toBe(true);

    await fresh.stopAll();
  }, 25000);
});
