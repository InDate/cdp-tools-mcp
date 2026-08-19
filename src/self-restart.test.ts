import { describe, it, expect, vi } from 'vitest';
import { requestSelfRestart, type SelfRestartDeps } from './self-restart.js';

function deps(overrides: Partial<SelfRestartDeps> = {}): SelfRestartDeps {
  return {
    readPidFile: vi.fn().mockResolvedValue(''),
    sendSignal: vi.fn(),
    ownParentPid: () => 999,
    ownServerDir: () => '/tree/build',
    ...overrides,
  };
}

const pidfile = (records: Array<{ pid: number; script: string | null }>) =>
  JSON.stringify({ supervisors: records });

describe('requestSelfRestart', () => {
  it('reports not-supervised when the pidfile is missing', async () => {
    const d = deps({ readPidFile: vi.fn().mockRejectedValue(new Error('ENOENT')) });

    const result = await requestSelfRestart(d);

    expect(result).toEqual({ ok: false, reason: 'not-supervised' });
    expect(d.sendSignal).not.toHaveBeenCalled();
  });

  it('reports not-supervised when the pidfile content is not a valid pid', async () => {
    const d = deps({ readPidFile: vi.fn().mockResolvedValue('not-a-number') });

    const result = await requestSelfRestart(d);

    expect(result).toEqual({ ok: false, reason: 'not-supervised' });
    expect(d.sendSignal).not.toHaveBeenCalled();
  });

  it('sends SIGUSR2 to a lone pre-multi-record pid and reports success', async () => {
    const d = deps({ readPidFile: vi.fn().mockResolvedValue('12345\n') });

    const result = await requestSelfRestart(d);

    expect(d.sendSignal).toHaveBeenCalledWith(12345, 'SIGUSR2');
    expect(result).toEqual({ ok: true, pid: 12345 });
  });

  it('reports stale-pid when signaling the pid throws (process no longer exists)', async () => {
    const d = deps({
      readPidFile: vi.fn().mockResolvedValue('12345'),
      sendSignal: vi.fn().mockImplementation(() => {
        throw new Error('ESRCH');
      }),
    });

    const result = await requestSelfRestart(d);

    expect(result).toEqual({ ok: false, pid: 12345, reason: 'stale-pid', error: 'ESRCH' });
  });

  it('signals the parent supervisor, not whichever record was written last', async () => {
    const d = deps({
      readPidFile: vi.fn().mockResolvedValue(
        pidfile([
          { pid: 4242, script: '/other/build/mcp-supervisor.js' },
          { pid: 999, script: '/tree/build/mcp-supervisor.js' },
        ])
      ),
    });

    const result = await requestSelfRestart(d);

    expect(d.sendSignal).toHaveBeenCalledWith(999, 'SIGUSR2');
    expect(result).toEqual({ ok: true, pid: 999 });
  });

  it('falls back to the sole record built from this server\'s directory', async () => {
    const d = deps({
      ownParentPid: () => 1,
      readPidFile: vi.fn().mockResolvedValue(
        pidfile([
          { pid: 4242, script: '/other/build/mcp-supervisor.js' },
          { pid: 777, script: '/tree/build/mcp-supervisor.js' },
        ])
      ),
    });

    const result = await requestSelfRestart(d);

    expect(d.sendSignal).toHaveBeenCalledWith(777, 'SIGUSR2');
    expect(result).toEqual({ ok: true, pid: 777 });
  });

  it('signals nothing when every record belongs to another tree', async () => {
    const d = deps({
      ownParentPid: () => 1,
      readPidFile: vi.fn().mockResolvedValue(
        pidfile([
          { pid: 4242, script: '/other/build/mcp-supervisor.js' },
          { pid: 4243, script: '/elsewhere/build/mcp-supervisor.js' },
        ])
      ),
    });

    const result = await requestSelfRestart(d);

    expect(d.sendSignal).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: 'foreign-supervisor', otherPids: [4242, 4243] });
  });
});
