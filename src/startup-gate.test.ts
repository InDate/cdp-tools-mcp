/**
 * The bug the gate exists for: with the transport serving before
 * serverManager.initialize() restored state, the first tool calls of a session
 * were answered against an empty world. A dead server did not block, and
 * `acknowledgeStartup` in that window acknowledged nothing - so the block came
 * straight back once recovery landed and the acknowledgement looked like it had
 * silently undone itself.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createStartupGate } from './startup-gate.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startup gate', () => {
  it('holds callers until recovery reports in', async () => {
    const gate = createStartupGate({ timeoutMs: 30_000 });
    let released = false;
    const waiter = gate.wait().then(() => { released = true; });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(released).toBe(false);
    expect(gate.isPending()).toBe(true);

    gate.markComplete();
    await waiter;
    expect(released).toBe(true);
    expect(gate.isPending()).toBe(false);
  });

  it('releases everyone waiting, not just the first', async () => {
    const gate = createStartupGate({ timeoutMs: 30_000 });
    const order: number[] = [];
    const waiters = [1, 2, 3].map(n => gate.wait().then(() => order.push(n)));

    gate.markComplete();
    await Promise.all(waiters);

    expect(order).toEqual([1, 2, 3]);
  });

  it('returns immediately once complete, without arming a timer', async () => {
    const gate = createStartupGate({ timeoutMs: 30_000 });
    gate.markComplete();

    const before = vi.getTimerCount();
    await gate.wait();
    expect(vi.getTimerCount()).toBe(before);
  });

  it('gives up after the cap so a hung recovery cannot wedge every tool', async () => {
    const onTimeout = vi.fn();
    const gate = createStartupGate({ timeoutMs: 30_000, onTimeout });
    let released = false;
    const waiter = gate.wait().then(() => { released = true; });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(released).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await waiter;
    expect(released).toBe(true);
    expect(onTimeout).toHaveBeenCalledWith(30_000);
    // Recovery never reported in, so later callers must not wait again
    expect(gate.isPending()).toBe(true);
  });

  it('clears its timer when recovery wins the race', async () => {
    const gate = createStartupGate({ timeoutMs: 30_000 });
    const waiter = gate.wait();

    gate.markComplete();
    await waiter;

    expect(vi.getTimerCount()).toBe(0);
  });

  it('markComplete is idempotent', async () => {
    const gate = createStartupGate({ timeoutMs: 30_000 });
    gate.markComplete();
    gate.markComplete();

    await expect(gate.wait()).resolves.toBeUndefined();
  });
});
