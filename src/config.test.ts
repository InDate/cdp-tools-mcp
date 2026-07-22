import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setWorkingDirOverride } from './helpers/paths.js';
import { ConfigManager } from './config.js';
import {
  isDebugEnabled,
  disableDebugLogging,
  isHistoryLogEnabled,
  disableHistoryLogging,
} from './debug-logger.js';

let tempDir: string;
let manager: ConfigManager;

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(join(tmpdir(), 'cdp-tools-config-test-'));
  setWorkingDirOverride(tempDir);
  // A fresh instance (not the shared singleton) so this test's cwd override
  // is the only thing that ever influences it.
  manager = new ConfigManager();
});

afterEach(async () => {
  manager.stopWatching();
  disableDebugLogging();
  disableHistoryLogging();
  await fsp.rm(tempDir, { recursive: true, force: true });
});

async function readConfigFile(): Promise<any> {
  const configPath = join(tempDir, '.cdp-tools', 'config.json');
  return JSON.parse(await fsp.readFile(configPath, 'utf-8'));
}

async function writeConfigFile(config: any): Promise<void> {
  const configPath = join(tempDir, '.cdp-tools', 'config.json');
  await fsp.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

describe('ConfigManager live reload', () => {
  it('reload() picks up an externally-written edit to config.json', async () => {
    const onDisk = await readConfigFile();
    expect(onDisk.debug.enabled).toBe(false);

    onDisk.debug.enabled = true;
    await writeConfigFile(onDisk);

    const result = await manager.reload();
    expect(result.changed).toBe(true);
    expect(manager.getDebugConfig().enabled).toBe(true);
  });

  it('reload() reports no change when the file is unchanged', async () => {
    const result = await manager.reload();
    expect(result.changed).toBe(false);
  });

  it('applies debug.enabled/historyLogEnabled live to debug-logger.ts on reload', async () => {
    expect(isDebugEnabled()).toBe(false);
    expect(isHistoryLogEnabled()).toBe(false);

    const onDisk = await readConfigFile();
    onDisk.debug.enabled = true;
    onDisk.debug.historyLogEnabled = true;
    await writeConfigFile(onDisk);

    await manager.reload();

    expect(isDebugEnabled()).toBe(true);
    expect(isHistoryLogEnabled()).toBe(true);
  });

  it('auto-reloads via the file watcher after a debounced external edit', async () => {
    manager.startWatching();

    const onDisk = await readConfigFile();
    const expected = !onDisk.replay.showCursor;
    onDisk.replay.showCursor = expected;
    await writeConfigFile(onDisk);

    // Wait past the debounce window for the watcher's reload to land.
    await new Promise(resolve => setTimeout(resolve, 500));

    expect(manager.getReplayConfig().showCursor).toBe(expected);
  });
});
