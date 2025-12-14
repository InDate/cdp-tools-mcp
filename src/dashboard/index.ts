/**
 * Dashboard Module
 * Exports hub election logic and client
 */

import { DashboardHub } from './dashboard-hub.js';
import { DashboardClient } from './dashboard-client.js';
import { readLock, isLockStale, isHubAlive, DEFAULT_PORT } from './hub-lock.js';
import type { ConnectionInfo } from './types.js';

export { DashboardHub } from './dashboard-hub.js';
export { DashboardClient } from './dashboard-client.js';
export type { ConnectionInfo, SessionInfo, ProjectInfo, DashboardState } from './types.js';

export interface DashboardInstance {
  type: 'hub' | 'client';
  hub: DashboardHub | null;
  client: DashboardClient | null;
  port: number;
}

/**
 * Try to become hub or connect as client
 */
export async function initializeDashboard(
  cwd: string,
  startedAt: number,
  connectionGetter: () => ConnectionInfo[],
  sessionId?: string,
  shortId?: string,
  onHubDown?: () => void
): Promise<DashboardInstance | null> {
  // Check existing lock
  const lock = readLock();

  if (lock) {
    // Check if existing hub is alive
    if (!isLockStale(lock) && await isHubAlive(lock)) {
      // Connect as client
      const client = new DashboardClient(
        process.pid,
        cwd,
        startedAt,
        lock.port,
        connectionGetter,
        sessionId,
        shortId,
        onHubDown
      );

      const connected = await client.connect();
      if (connected) {
        return {
          type: 'client',
          hub: null,
          client,
          port: lock.port,
        };
      }
    }
    // Lock is stale or hub is dead, try to become hub
  }

  // Try to become hub
  const hub = new DashboardHub();
  const started = await hub.start(DEFAULT_PORT);

  if (started) {
    // Register self with hub
    hub.registerSelf(cwd, startedAt, sessionId, shortId);

    return {
      type: 'hub',
      hub,
      client: null,
      port: hub.getPort(),
    };
  }

  // Failed to become hub (all ports in use)
  // Try connecting as client one more time
  const retryLock = readLock();
  if (retryLock) {
    const client = new DashboardClient(
      process.pid,
      cwd,
      startedAt,
      retryLock.port,
      connectionGetter,
      sessionId,
      shortId,
      onHubDown
    );

    const connected = await client.connect();
    if (connected) {
      return {
        type: 'client',
        hub: null,
        client,
        port: retryLock.port,
      };
    }
  }

  // Could not become hub or client
  return null;
}

/**
 * Clean up dashboard resources
 */
export async function shutdownDashboard(instance: DashboardInstance | null): Promise<void> {
  if (!instance) return;

  if (instance.hub) {
    await instance.hub.stop();
  }

  if (instance.client) {
    await instance.client.disconnect();
  }
}
