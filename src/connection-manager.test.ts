/**
 * Unit tests for ConnectionManager cleanup paths:
 * - Inactivity-triggered closeConnection() correctly checks for recent
 *   console/network activity before tearing anything down, and tags the
 *   resulting Chrome kill with the right reason (not a manual close).
 * - Stale/close cleanup best-effort disconnects the cdpManager even when the
 *   underlying connection is already dead, so a paused-then-killed process
 *   doesn't leave dependent state (e.g. port monitoring) stuck forever.
 */

import { describe, it, expect, vi } from 'vitest';
import { ConnectionManager } from './connection-manager.js';

function mockCdpManager(overrides: {
  getRuntimeType?: () => string;
  disconnect?: () => Promise<void>;
} = {}) {
  return {
    getRuntimeType: overrides.getRuntimeType ?? (() => 'chrome'),
    disconnect: overrides.disconnect ?? vi.fn().mockResolvedValue(undefined),
  };
}

function mockChromeLauncher() {
  const calls = { setPendingCloseReason: [] as Array<{ port: number; reason: string }>, kill: [] as number[] };
  return {
    calls,
    setPendingCloseReason(port: number, reason: string) {
      calls.setPendingCloseReason.push({ port, reason });
    },
    async kill(port: number) {
      calls.kill.push(port);
    },
  };
}

describe('ConnectionManager.closeConnection - inactivity activity check', () => {
  it('does not close a connection with recent console/network activity', async () => {
    const cm = new ConnectionManager();
    const launcher = mockChromeLauncher();
    cm.setChromeLauncher(launcher as any);

    const consoleMonitor = { hasRecentActivity: () => true };
    const id = cm.createConnection(mockCdpManager() as any, undefined, consoleMonitor as any, undefined, 'localhost', 9201);
    const conn = cm.getConnection(id)!;
    conn.lastActivityAt = Date.now() - 10 * 60 * 1000;

    const closed = await cm.closeConnection(id, { reason: 'inactivity', inactivityThresholdMs: 5 * 60 * 1000 });

    expect(closed).toBe(false);
    expect(cm.getConnection(id)).not.toBeNull();
    expect(launcher.calls.kill).toHaveLength(0);
  });

  it('closes a genuinely idle connection and tags the Chrome kill as inactivity', async () => {
    const cm = new ConnectionManager();
    const launcher = mockChromeLauncher();
    cm.setChromeLauncher(launcher as any);

    const consoleMonitor = { hasRecentActivity: () => false };
    const networkMonitor = { hasRecentActivity: () => false };
    const id = cm.createConnection(mockCdpManager() as any, undefined, consoleMonitor as any, networkMonitor as any, 'localhost', 9202);
    const conn = cm.getConnection(id)!;
    conn.lastActivityAt = Date.now() - 10 * 60 * 1000;

    const closed = await cm.closeConnection(id, { reason: 'inactivity', inactivityThresholdMs: 5 * 60 * 1000 });

    expect(closed).toBe(true);
    expect(cm.getConnection(id)).toBeNull();
    expect(launcher.calls.setPendingCloseReason).toEqual([{ port: 9202, reason: 'inactivity' }]);
    expect(launcher.calls.kill).toEqual([9202]);
  });

  it('manual close (e.g. tab close) ignores the activity check and does not tag a reason', async () => {
    const cm = new ConnectionManager();
    const launcher = mockChromeLauncher();
    cm.setChromeLauncher(launcher as any);

    const consoleMonitor = { hasRecentActivity: () => true }; // even with recent activity...
    const id = cm.createConnection(mockCdpManager() as any, undefined, consoleMonitor as any, undefined, 'localhost', 9203);

    const closed = await cm.closeConnection(id); // ...manual close (no options) should just close

    expect(closed).toBe(true);
    expect(launcher.calls.setPendingCloseReason).toHaveLength(0);
    expect(launcher.calls.kill).toEqual([9203]);
  });

  it('closeInactiveConnections only counts connections actually closed', async () => {
    const cm = new ConnectionManager();
    const launcher = mockChromeLauncher();
    cm.setChromeLauncher(launcher as any);

    const activeConsole = { hasRecentActivity: () => true };
    const idleConsole = { hasRecentActivity: () => false };

    const activeId = cm.createConnection(mockCdpManager() as any, undefined, activeConsole as any, undefined, 'localhost', 9204);
    const idleId = cm.createConnection(mockCdpManager() as any, undefined, idleConsole as any, undefined, 'localhost', 9205);
    cm.getConnection(activeId)!.lastActivityAt = Date.now() - 10 * 60 * 1000;
    cm.getConnection(idleId)!.lastActivityAt = Date.now() - 10 * 60 * 1000;

    const closedCount = await cm.closeInactiveConnections(5 * 60 * 1000);

    expect(closedCount).toBe(1);
    expect(cm.getConnection(activeId)).not.toBeNull();
    expect(cm.getConnection(idleId)).toBeNull();
  });
});

describe('ConnectionManager - best-effort cdpManager.disconnect() on cleanup', () => {
  it('removeStaleConnection disconnects the cdpManager', async () => {
    const cm = new ConnectionManager();
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const id = cm.createConnection(mockCdpManager({ disconnect }) as any, undefined, undefined, undefined, 'localhost', 9206);

    const removed = await cm.removeStaleConnection(id);

    expect(removed).toBe(true);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(cm.getConnection(id)).toBeNull();
  });

  it('removeStaleConnection still removes the connection if disconnect() throws', async () => {
    const cm = new ConnectionManager();
    const disconnect = vi.fn().mockRejectedValue(new Error('already dead'));
    const id = cm.createConnection(mockCdpManager({ disconnect }) as any, undefined, undefined, undefined, 'localhost', 9207);

    const removed = await cm.removeStaleConnection(id);

    expect(removed).toBe(true);
    expect(cm.getConnection(id)).toBeNull();
  });

  it('closeConnection still cleans up if cdpManager.disconnect() throws', async () => {
    const cm = new ConnectionManager();
    const disconnect = vi.fn().mockRejectedValue(new Error('socket already closed'));
    const id = cm.createConnection(mockCdpManager({ disconnect }) as any, undefined, undefined, undefined, 'localhost', 9208);

    const closed = await cm.closeConnection(id);

    expect(closed).toBe(true);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(cm.getConnection(id)).toBeNull();
  });
});
