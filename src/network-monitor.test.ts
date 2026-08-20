/**
 * Auto-attach holds every target related to the page before its first line, so
 * the resume decides whether the target ever runs. On a service worker target
 * `Network.enable` responds only once the target runs, and the target runs only
 * on `Runtime.runIfWaitingForDebugger` - awaiting the enable before sending the
 * resume deadlocks the registration that started the worker. These pin the
 * resume to the same turn as the attach, and pin it to the child session: sent
 * on the page session it lands on the page and leaves the child held.
 */

import { describe, it, expect } from 'vitest';
import { NetworkMonitor } from './network-monitor.js';

interface FakeSession {
  sent: Array<{ method: string; params: unknown }>;
  handlers: Map<string, (e: any) => void>;
  emit(event: string, payload: any): void;
  send(method: string, params?: unknown): Promise<unknown>;
  on(event: string, handler: (e: any) => void): void;
}

/** `hangOn` never settles, standing in for a held target's Network.enable. */
function fakeSession(hangOn?: string): FakeSession {
  const session: FakeSession = {
    sent: [],
    handlers: new Map(),
    emit(event, payload) {
      session.handlers.get(event)?.(payload);
    },
    send(method, params) {
      session.sent.push({ method, params });
      if (method === hangOn) return new Promise(() => {});
      return Promise.resolve({});
    },
    on(event, handler) {
      session.handlers.set(event, handler);
    },
  };
  return session;
}

function fakePage(pageSession: FakeSession, children: Map<string, FakeSession>) {
  // `connection()` and `session()` are read as a synchronous chain by the
  // handler under test, so neither may return a promise.
  (pageSession as any).connection = () => ({
    session: (id: string) => children.get(id) ?? null,
  });
  return {
    on() { /* request/response listeners are not under test */ },
    removeAllListeners() { /* same */ },
    async createCDPSession() { return pageSession; },
  };
}

/** startSocketMonitoring registers the attach handler behind two awaits. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function attachEvent(sessionId: string, type: string, waitingForDebugger: boolean) {
  return {
    sessionId,
    waitingForDebugger,
    targetInfo: { type, targetId: `t-${sessionId}`, url: `http://localhost/${type}.js` },
  };
}

describe('NetworkMonitor auto-attach resume', () => {
  it('resumes a held target whose Network.enable never responds', async () => {
    const pageSession = fakeSession();
    const child = fakeSession('Network.enable');
    const children = new Map([['sw-1', child]]);
    const monitor = new NetworkMonitor();

    monitor.startMonitoring(fakePage(pageSession, children) as any);
    await flush();
    pageSession.emit('Target.attachedToTarget', attachEvent('sw-1', 'service_worker', true));

    expect(child.sent.map((c) => c.method)).toContain('Runtime.runIfWaitingForDebugger');
  });

  it('sends the resume on the child session, never on the page session', async () => {
    const pageSession = fakeSession();
    const child = fakeSession('Network.enable');
    const monitor = new NetworkMonitor();

    monitor.startMonitoring(fakePage(pageSession, new Map([['sw-1', child]])) as any);
    await flush();
    pageSession.emit('Target.attachedToTarget', attachEvent('sw-1', 'service_worker', true));

    const resume = child.sent.find((c) => c.method === 'Runtime.runIfWaitingForDebugger');
    expect(resume).toBeDefined();
    expect(resume?.params).toBeUndefined();
    expect(pageSession.sent.map((c) => c.method)).not.toContain('Runtime.runIfWaitingForDebugger');
  });

  it('records a socket opened on a held target', async () => {
    const pageSession = fakeSession();
    const child = fakeSession('Network.enable');
    const monitor = new NetworkMonitor();

    monitor.startMonitoring(fakePage(pageSession, new Map([['sw-1', child]])) as any);
    await flush();
    pageSession.emit('Target.attachedToTarget', attachEvent('sw-1', 'service_worker', true));
    child.emit('Network.webSocketCreated', { requestId: '1', url: 'wss://example.test/sync' });

    const sockets = monitor.getSockets();
    expect(sockets).toHaveLength(1);
    expect(sockets[0].target).toBe('service_worker');
    expect(sockets[0].sessionId).toBe('sw-1');
  });

  it('sends no resume for a target that is not held', async () => {
    const pageSession = fakeSession();
    const child = fakeSession();
    const monitor = new NetworkMonitor();

    monitor.startMonitoring(fakePage(pageSession, new Map([['w-1', child]])) as any);
    await flush();
    pageSession.emit('Target.attachedToTarget', attachEvent('w-1', 'worker', false));

    expect(child.sent.map((c) => c.method)).toEqual(['Network.enable']);
  });
});
