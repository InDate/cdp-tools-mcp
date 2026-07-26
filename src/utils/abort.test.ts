// @vitest-environment node
// (node, not happy-dom: events.getEventListeners only accepts Node's own
// EventTarget, and these tests assert listener hygiene on real AbortSignals)
/**
 * Abort utilities (#110): linkSignals lifecycle/hygiene, abort-shape
 * classification (including the DOMException fetch throws), and both sleep
 * variants' cleanup behaviour.
 */
import { describe, it, expect } from 'vitest';
import { getEventListeners } from 'node:events';
import {
  AbortError,
  isAbortError,
  abortErrorFor,
  throwIfAborted,
  linkSignals,
  abortableSleep,
  abortableDelayResult,
} from './abort.js';

const listenerCount = (signal: AbortSignal) => getEventListeners(signal as any, 'abort').length;

describe('isAbortError', () => {
  it('matches our AbortError class', () => {
    expect(isAbortError(new AbortError())).toBe(true);
  });

  it('matches the DOMException a real fetch abort produces', async () => {
    const controller = new AbortController();
    controller.abort();
    // An already-aborted signal rejects before any connection is attempted.
    const err = await fetch('http://127.0.0.1:1/', { signal: controller.signal })
      .then(() => null, (e) => e);
    expect(err).not.toBeNull();
    expect(isAbortError(err)).toBe(true);
  });

  it('matches what signal.throwIfAborted() throws (the default abort reason)', () => {
    const controller = new AbortController();
    controller.abort();
    let thrown: unknown;
    try {
      (controller.signal as any).throwIfAborted();
    } catch (e) {
      thrown = e;
    }
    expect(isAbortError(thrown)).toBe(true);
  });

  it('rejects genuine failures', () => {
    expect(isAbortError(new Error('boom'))).toBe(false);
    expect(isAbortError(new RangeError('nope'))).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
    expect(isAbortError('AbortError')).toBe(false);
  });
});

describe('throwIfAborted / abortErrorFor', () => {
  it('throws an abort-shaped error carrying a custom reason', () => {
    const controller = new AbortController();
    const reason = new AbortError('run cancelled');
    controller.abort(reason);
    let thrown: unknown;
    try {
      throwIfAborted(controller.signal);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(reason);
    expect(isAbortError(abortErrorFor(controller.signal))).toBe(true);
  });

  it('is a no-op on a live or missing signal', () => {
    expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();
    expect(() => throwIfAborted(undefined)).not.toThrow();
  });
});

describe('linkSignals', () => {
  it('aborts when either input aborts, carrying the reason', () => {
    const a = new AbortController();
    const b = new AbortController();
    const link = linkSignals(a.signal, b.signal);
    try {
      expect(link.signal.aborted).toBe(false);
      const reason = new AbortError('b fired');
      b.abort(reason);
      expect(link.signal.aborted).toBe(true);
      expect((link.signal as any).reason).toBe(reason);
    } finally {
      link.dispose();
    }
  });

  it('aborts synchronously when an input is already aborted', () => {
    const a = new AbortController();
    a.abort(new AbortError('pre-aborted'));
    const link = linkSignals(a.signal, new AbortController().signal);
    expect(link.signal.aborted).toBe(true);
    link.dispose();
  });

  it('skips undefined inputs', () => {
    const a = new AbortController();
    const link = linkSignals(undefined, a.signal, undefined);
    try {
      a.abort();
      expect(link.signal.aborted).toBe(true);
    } finally {
      link.dispose();
    }
  });

  it('dispose() detaches every listener from the inputs', () => {
    const a = new AbortController();
    const b = new AbortController();
    const link = linkSignals(a.signal, b.signal);
    expect(listenerCount(a.signal)).toBe(1);
    expect(listenerCount(b.signal)).toBe(1);
    link.dispose();
    expect(listenerCount(a.signal)).toBe(0);
    expect(listenerCount(b.signal)).toBe(0);
    // A post-dispose abort no longer propagates
    a.abort();
    expect(link.signal.aborted).toBe(false);
  });

  it('detaches from ALL inputs as soon as one aborts (no leak on the survivor)', () => {
    const runController = new AbortController(); // long-lived
    const step = new AbortController();
    const link = linkSignals(runController.signal, step.signal);
    step.abort();
    expect(link.signal.aborted).toBe(true);
    expect(listenerCount(runController.signal)).toBe(0);
    link.dispose(); // idempotent
    expect(listenerCount(runController.signal)).toBe(0);
  });

  it('leaves no listeners on a long-lived signal after many link/dispose cycles', () => {
    const run = new AbortController();
    for (let i = 0; i < 200; i++) {
      const link = linkSignals(run.signal, new AbortController().signal);
      link.dispose();
    }
    expect(listenerCount(run.signal)).toBe(0);
  });
});

describe('abortableSleep', () => {
  it('resolves normally and leaves no listener behind', async () => {
    const controller = new AbortController();
    await abortableSleep(10, controller.signal);
    expect(listenerCount(controller.signal)).toBe(0);
  });

  it('rejects with an abort-shaped error when aborted mid-sleep', async () => {
    const controller = new AbortController();
    const p = abortableSleep(5000, controller.signal);
    setTimeout(() => controller.abort(), 10);
    const start = Date.now();
    await expect(p).rejects.toSatisfy(isAbortError);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('rejects immediately on an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(abortableSleep(5000, controller.signal)).rejects.toSatisfy(isAbortError);
  });

  it('works without a signal', async () => {
    await expect(abortableSleep(1)).resolves.toBeUndefined();
  });
});

describe('abortableDelayResult', () => {
  it('resolves false when the delay elapses, with no leaked listener or timer', async () => {
    const controller = new AbortController();
    await expect(abortableDelayResult(10, controller.signal)).resolves.toBe(false);
    expect(listenerCount(controller.signal)).toBe(0);
  });

  it('resolves true promptly when aborted mid-delay', async () => {
    const controller = new AbortController();
    const p = abortableDelayResult(5000, controller.signal);
    setTimeout(() => controller.abort(), 10);
    const start = Date.now();
    await expect(p).resolves.toBe(true);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('resolves true immediately on an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(abortableDelayResult(5000, controller.signal)).resolves.toBe(true);
  });
});
