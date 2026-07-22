import { describe, it, expect, vi } from 'vitest';
import { requestSelfRestart } from './self-restart.js';

describe('requestSelfRestart', () => {
  it('reports not-supervised when the pidfile is missing', async () => {
    const readPidFile = vi.fn().mockRejectedValue(new Error('ENOENT'));
    const sendSignal = vi.fn();

    const result = await requestSelfRestart({ readPidFile, sendSignal });

    expect(result).toEqual({ ok: false, reason: 'not-supervised' });
    expect(sendSignal).not.toHaveBeenCalled();
  });

  it('reports not-supervised when the pidfile content is not a valid pid', async () => {
    const readPidFile = vi.fn().mockResolvedValue('not-a-number');
    const sendSignal = vi.fn();

    const result = await requestSelfRestart({ readPidFile, sendSignal });

    expect(result).toEqual({ ok: false, reason: 'not-supervised' });
    expect(sendSignal).not.toHaveBeenCalled();
  });

  it('sends SIGUSR2 to the pid from the pidfile and reports success', async () => {
    const readPidFile = vi.fn().mockResolvedValue('12345\n');
    const sendSignal = vi.fn();

    const result = await requestSelfRestart({ readPidFile, sendSignal });

    expect(sendSignal).toHaveBeenCalledWith(12345, 'SIGUSR2');
    expect(result).toEqual({ ok: true, pid: 12345 });
  });

  it('reports stale-pid when signaling the pid throws (process no longer exists)', async () => {
    const readPidFile = vi.fn().mockResolvedValue('12345');
    const sendSignal = vi.fn().mockImplementation(() => {
      throw new Error('ESRCH');
    });

    const result = await requestSelfRestart({ readPidFile, sendSignal });

    expect(result).toEqual({ ok: false, pid: 12345, reason: 'stale-pid', error: 'ESRCH' });
  });
});
