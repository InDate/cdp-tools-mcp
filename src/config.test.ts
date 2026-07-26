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

    // Poll, and re-save on each tick, rather than writing once and sleeping.
    // This was the suite's only flaky test. Two separate causes: a fixed 500ms
    // wait that a loaded machine could overrun, and - the stubborn one -
    // fs.watch on macOS silently dropping a lone change event when many
    // watchers are active, which is exactly what a full parallel test run
    // creates. A dropped event is OS behaviour, not a defect in ConfigManager,
    // so depending on one event surviving made this test assert the platform
    // rather than the code. Re-saving keeps the intent (the watcher notices an
    // external edit and reloads) while removing that dependency; if the
    // watcher or reload were genuinely broken, no number of saves would help.
    const deadline = Date.now() + 10_000;
    while (manager.getReplayConfig().showCursor !== expected && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
      await writeConfigFile(onDisk);
    }

    expect(manager.getReplayConfig().showCursor).toBe(expected);
  }, 15_000); // above the poll deadline, so a timeout reports the assertion not the runner

  it('still reloads while an unrelated file in the watched directory is being written continuously', async () => {
    // The reload used to be debounced by resetting its timer on every event.
    // Because startWatching() also watches the shared global ~/.cdp-tools,
    // sustained writes by any other cdp-tools process reset that timer forever
    // and live reload silently stopped working. This drives that scenario:
    // a config edit, then a steady stream of unrelated writes in the same
    // directory. Against the old resetting debounce this times out.
    manager.startWatching();

    const onDisk = await readConfigFile();
    const expected = !onDisk.replay.showCursor;
    onDisk.replay.showCursor = expected;
    await writeConfigFile(onDisk);

    const noisePath = join(tempDir, '.cdp-tools', 'unrelated.lock');
    let noisy = true;
    const noise = (async () => {
      while (noisy) {
        await fsp.writeFile(noisePath, String(Date.now()), 'utf-8');
        await new Promise(resolve => setTimeout(resolve, 20)); // < the 250ms debounce
      }
    })();

    try {
      const deadline = Date.now() + 10_000;
      while (manager.getReplayConfig().showCursor !== expected && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      expect(manager.getReplayConfig().showCursor).toBe(expected);
    } finally {
      noisy = false;
      await noise;
    }
  }, 15_000);
});
