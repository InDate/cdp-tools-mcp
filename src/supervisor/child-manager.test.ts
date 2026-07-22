import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as url from 'url';
import { ChildManager } from './child-manager.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, '__fixtures__', 'test-child.mjs');

describe('ChildManager (real subprocess)', () => {
  it('spawns a child and kill() resolves once it exits on SIGTERM', async () => {
    const manager = new ChildManager({
      execPath: process.execPath,
      scriptPath: FIXTURE_PATH,
      extraArgs: [],
      cwd: __dirname,
      killGraceMs: 3000,
    });

    manager.spawn();
    expect(manager.isRunning()).toBe(true);

    await manager.kill();
    expect(manager.isRunning()).toBe(false);
  }, 10000);

  it('escalates to SIGKILL after the grace period for a child that ignores SIGTERM', async () => {
    const manager = new ChildManager({
      execPath: process.execPath,
      scriptPath: FIXTURE_PATH,
      extraArgs: ['ignore-sigterm'],
      cwd: __dirname,
      killGraceMs: 300, // short for test speed
    });

    manager.spawn();
    // Give the child a moment to actually register its SIGTERM-ignoring handler
    // before we send the signal, or we'd race its own startup.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const start = Date.now();
    await manager.kill();
    const elapsed = Date.now() - start;

    expect(manager.isRunning()).toBe(false);
    // Should have waited roughly the grace period before SIGKILL landed, not exited instantly.
    expect(elapsed).toBeGreaterThanOrEqual(250);
  }, 10000);

  it('fires onExit for a child that crashes on its own', async () => {
    const manager = new ChildManager({
      execPath: process.execPath,
      scriptPath: FIXTURE_PATH,
      extraArgs: ['crash'],
      cwd: __dirname,
    });

    const exitInfo = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      manager.onExit((info) => resolve(info));
      manager.spawn();
    });

    expect(exitInfo.code).toBe(1);
  }, 10000);

  it('kill() on an already-dead child resolves immediately without throwing', async () => {
    const manager = new ChildManager({
      execPath: process.execPath,
      scriptPath: FIXTURE_PATH,
      extraArgs: ['crash'],
      cwd: __dirname,
    });

    await new Promise<void>((resolve) => {
      manager.onExit(() => resolve());
      manager.spawn();
    });

    await expect(manager.kill()).resolves.toBeUndefined();
  }, 10000);
});
