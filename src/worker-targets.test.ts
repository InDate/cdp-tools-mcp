/**
 * A worker's script runs in its own target, so a reference has to name exactly
 * one. A substring matching two targets resolved to the first would evaluate
 * inside a worker the caller did not choose, and a client left open holds its
 * worker alive past the browser that owned it - these pin both.
 */

import { describe, it, expect } from 'vitest';
import {
  WorkerTargetRegistry,
  WorkerTargetNotFoundError,
  WorkerTargetAmbiguousError,
  WorkerEvaluateError,
} from './worker-targets.js';

const TARGETS = [
  { id: 'page-1', type: 'page', url: 'http://localhost:5173/' },
  { id: 'sw-1', type: 'service_worker', url: 'http://localhost:5173/sw.js' },
  { id: 'w-1', type: 'worker', url: 'http://localhost:5173/worker.js' },
  { id: 'w-2', type: 'worker', url: 'http://localhost:5173/second-worker.js' },
];

function fakeClient(evaluate?: (params: any) => any) {
  const client: any = {
    closed: false,
    handlers: {} as Record<string, (e: any) => void>,
    Runtime: {
      enable: async () => {},
      evaluate: async (params: any) => (evaluate ? evaluate(params) : { result: { value: 'ok' } }),
      consoleAPICalled: (h: (e: any) => void) => { client.handlers.console = h; },
      exceptionThrown: (h: (e: any) => void) => { client.handlers.exception = h; },
    },
    close: async () => { client.closed = true; },
  };
  return client;
}

function registry(options: { targets?: any[]; evaluate?: (params: any) => any } = {}) {
  const clients: any[] = [];
  const connect = async () => {
    const client = fakeClient(options.evaluate);
    clients.push(client);
    return client;
  };
  const instance = new WorkerTargetRegistry(
    'localhost',
    9222,
    async () => options.targets ?? TARGETS,
    connect as any
  );
  return { instance, clients };
}

describe('WorkerTargetRegistry.list', () => {
  it('lists only targets that run script outside the page', async () => {
    const { instance } = registry();
    const types = (await instance.list()).map((t) => t.type);
    expect(types).toEqual(['service_worker', 'worker', 'worker']);
  });

  it('marks a target attached once a client is open on it', async () => {
    const { instance } = registry();
    await instance.evaluate('sw-1', '1');
    const sw = (await instance.list()).find((t) => t.targetId === 'sw-1');
    expect(sw?.attached).toBe(true);
  });
});

describe('WorkerTargetRegistry.resolve', () => {
  it('takes a target id', async () => {
    const { instance } = registry();
    expect((await instance.resolve('sw-1')).url).toBe('http://localhost:5173/sw.js');
  });

  it('takes a URL substring that matches one target', async () => {
    const { instance } = registry();
    expect((await instance.resolve('sw.js')).targetId).toBe('sw-1');
  });

  it('refuses a substring matching more than one, naming both', async () => {
    const { instance } = registry();
    await expect(instance.resolve('worker.js')).rejects.toBeInstanceOf(WorkerTargetAmbiguousError);
    const error = await instance.resolve('worker.js').catch((e) => e);
    expect(error.matches.map((t: any) => t.targetId)).toEqual(['w-1', 'w-2']);
  });

  it('refuses a reference matching nothing, listing what there is', async () => {
    const { instance } = registry();
    const error = await instance.resolve('absent.js').catch((e) => e);
    expect(error).toBeInstanceOf(WorkerTargetNotFoundError);
    expect(error.available.map((t: any) => t.targetId)).toEqual(['sw-1', 'w-1', 'w-2']);
  });
});

describe('WorkerTargetRegistry.evaluate', () => {
  it('returns the by-value result', async () => {
    const { instance } = registry({ evaluate: () => ({ result: { value: 'ServiceWorkerGlobalScope' } }) });
    expect(await instance.evaluate('sw-1', 'self.constructor.name')).toBe('ServiceWorkerGlobalScope');
  });

  it('raises what the worker threw', async () => {
    const { instance } = registry({
      evaluate: () => ({ exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: nope' } } }),
    });
    await expect(instance.evaluate('sw-1', 'nope()')).rejects.toBeInstanceOf(WorkerEvaluateError);
  });

  it('opens one client per target, however many evaluations', async () => {
    const { instance, clients } = registry();
    await instance.evaluate('sw-1', '1');
    await instance.evaluate('sw-1', '2');
    expect(clients).toHaveLength(1);
  });
});

describe('WorkerTargetRegistry console', () => {
  it('records console output from the target', async () => {
    const { instance, clients } = registry();
    await instance.evaluate('sw-1', '1');
    clients[0].handlers.console({ type: 'log', args: [{ value: 'inside' }, { value: 42 }] });
    const messages = await instance.messages('sw-1');
    expect(messages.map((m) => m.text)).toEqual(['inside 42']);
  });

  it('records an exception thrown in the target as an error', async () => {
    const { instance, clients } = registry();
    await instance.evaluate('sw-1', '1');
    clients[0].handlers.exception({ exceptionDetails: { exception: { description: 'TypeError: nope' } } });
    const messages = await instance.messages('sw-1');
    expect(messages[0]).toMatchObject({ type: 'error', text: 'TypeError: nope' });
  });
});

describe('WorkerTargetRegistry.dispose', () => {
  it('closes every client it opened', async () => {
    const { instance, clients } = registry();
    await instance.evaluate('sw-1', '1');
    await instance.evaluate('w-1', '1');

    await instance.dispose();

    expect(clients.map((c) => c.closed)).toEqual([true, true]);
    expect((await instance.list()).every((t) => !t.attached)).toBe(true);
  });
});
