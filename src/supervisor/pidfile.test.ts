/**
 * Observed for real: two supervisors were running in this project, and when the
 * three-day-old one exited it deleted the pidfile belonging to the one actually
 * serving the session. From then on `npm run build` signalled nothing - the
 * build succeeded, the running server kept the old code, and nothing said so.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseSupervisorRecords, readSupervisorRecords, recordOwnSupervisor, removeOwnPidFile } from './pidfile.js';

let dir: string;
let pidFile: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'cdp-tools-pidfile-'));
  pidFile = join(dir, 'mcp-supervisor.pid');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const exists = async () => fs.access(pidFile).then(() => true, () => false);

describe('removeOwnPidFile', () => {
  it('removes the pidfile when it still names this process', async () => {
    await fs.writeFile(pidFile, '4242');
    expect(await removeOwnPidFile(pidFile, 4242)).toBe(true);
    expect(await exists()).toBe(false);
  });

  it('leaves a pidfile that a newer supervisor has taken over', async () => {
    await fs.writeFile(pidFile, '9999');   // the live supervisor
    expect(await removeOwnPidFile(pidFile, 4242)).toBe(false);   // an older one exiting
    expect(await fs.readFile(pidFile, 'utf-8')).toBe('9999');
  });

  it('tolerates trailing whitespace, as an atomic write can leave', async () => {
    await fs.writeFile(pidFile, '4242\n');
    expect(await removeOwnPidFile(pidFile, 4242)).toBe(true);
  });

  it('is a no-op when the pidfile is already gone', async () => {
    expect(await removeOwnPidFile(pidFile, 4242)).toBe(false);
  });

  it('leaves an unparseable pidfile alone rather than guessing', async () => {
    await fs.writeFile(pidFile, 'not-a-pid');
    expect(await removeOwnPidFile(pidFile, 4242)).toBe(false);
    expect(await exists()).toBe(true);
  });
});

describe('recordOwnSupervisor', () => {
  it('keeps a live supervisor already holding the root, so both stay reachable', async () => {
    await recordOwnSupervisor(pidFile, { pid: 111, script: '/npx/build/mcp-supervisor.js' }, () => true);
    await recordOwnSupervisor(pidFile, { pid: 222, script: '/tree/build/mcp-supervisor.js' }, () => true);

    expect(await readSupervisorRecords(pidFile)).toEqual([
      { pid: 111, script: '/npx/build/mcp-supervisor.js' },
      { pid: 222, script: '/tree/build/mcp-supervisor.js' },
    ]);
  });

  it('drops a dead pid rather than carrying it to whatever recycles it', async () => {
    await recordOwnSupervisor(pidFile, { pid: 111, script: '/npx/build/mcp-supervisor.js' }, () => true);
    await recordOwnSupervisor(pidFile, { pid: 222, script: '/tree/build/mcp-supervisor.js' }, pid => pid !== 111);

    expect(await readSupervisorRecords(pidFile)).toEqual([{ pid: 222, script: '/tree/build/mcp-supervisor.js' }]);
  });

  it('replaces its own earlier record instead of listing itself twice', async () => {
    await recordOwnSupervisor(pidFile, { pid: 222, script: '/tree/build/mcp-supervisor.js' }, () => true);
    await recordOwnSupervisor(pidFile, { pid: 222, script: '/tree/build/mcp-supervisor.js' }, () => true);

    expect(await readSupervisorRecords(pidFile)).toEqual([{ pid: 222, script: '/tree/build/mcp-supervisor.js' }]);
  });

  it('reads a bare pid written by an older supervisor', async () => {
    expect(parseSupervisorRecords('4242\n')).toEqual([{ pid: 4242, script: null }]);
  });
});

describe('removeOwnPidFile with several supervisors recorded', () => {
  it('removes only its own record and leaves the file for the others', async () => {
    await recordOwnSupervisor(pidFile, { pid: 111, script: '/npx/build/mcp-supervisor.js' }, () => true);
    await recordOwnSupervisor(pidFile, { pid: 222, script: '/tree/build/mcp-supervisor.js' }, () => true);

    expect(await removeOwnPidFile(pidFile, 222)).toBe(true);
    expect(await readSupervisorRecords(pidFile)).toEqual([{ pid: 111, script: '/npx/build/mcp-supervisor.js' }]);
  });

  it('leaves a record it does not own', async () => {
    await recordOwnSupervisor(pidFile, { pid: 111, script: '/npx/build/mcp-supervisor.js' }, () => true);

    expect(await removeOwnPidFile(pidFile, 222)).toBe(false);
    expect(await readSupervisorRecords(pidFile)).toEqual([{ pid: 111, script: '/npx/build/mcp-supervisor.js' }]);
  });
});
