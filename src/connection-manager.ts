/**
 * Connection Manager
 * Manages multiple debugger connections (Chrome, Node.js, etc.)
 */

import { CDPManager } from './cdp-manager.js';
import { PuppeteerManager } from './puppeteer-manager.js';
import { ConsoleMonitor } from './console-monitor.js';
import { NetworkMonitor } from './network-monitor.js';
import type { RuntimeType } from './types.js';

export interface Connection {
  id: string;
  type: RuntimeType;
  cdpManager: CDPManager;
  puppeteerManager?: PuppeteerManager;
  consoleMonitor?: ConsoleMonitor;
  networkMonitor?: NetworkMonitor;
  host: string;
  port: number;
  createdAt: number;
}

export class ConnectionManager {
  private connections: Map<string, Connection> = new Map();
  private activeConnectionId: string | null = null;
  private connectionCounter = 0;

  /**
   * Create a new connection
   */
  createConnection(
    cdpManager: CDPManager,
    puppeteerManager?: PuppeteerManager,
    consoleMonitor?: ConsoleMonitor,
    networkMonitor?: NetworkMonitor,
    host: string = 'localhost',
    port: number = 9222
  ): string {
    const id = `conn-${++this.connectionCounter}`;
    const type = cdpManager.getRuntimeType();

    const connection: Connection = {
      id,
      type,
      cdpManager,
      puppeteerManager,
      consoleMonitor,
      networkMonitor,
      host,
      port,
      createdAt: Date.now(),
    };

    this.connections.set(id, connection);

    // Set as active if it's the first connection
    if (this.connections.size === 1) {
      this.activeConnectionId = id;
    }

    return id;
  }

  /**
   * Get a connection by ID (or active if not specified)
   */
  getConnection(id?: string): Connection | null {
    if (id) {
      return this.connections.get(id) || null;
    }

    if (this.activeConnectionId) {
      return this.connections.get(this.activeConnectionId) || null;
    }

    return null;
  }

  /**
   * Get all connections
   */
  listConnections(): Connection[] {
    return Array.from(this.connections.values());
  }

  /**
   * Set the active connection
   */
  setActiveConnection(id: string): boolean {
    if (this.connections.has(id)) {
      this.activeConnectionId = id;
      return true;
    }
    return false;
  }

  /**
   * Get the active connection ID
   */
  getActiveConnectionId(): string | null {
    return this.activeConnectionId;
  }

  /**
   * Close a connection
   */
  async closeConnection(id: string): Promise<boolean> {
    const connection = this.connections.get(id);
    if (!connection) {
      return false;
    }

    // Stop monitoring if applicable
    if (connection.puppeteerManager?.isConnected()) {
      const page = connection.puppeteerManager.getPage();
      connection.consoleMonitor?.stopMonitoring(page);
      connection.networkMonitor?.stopMonitoring(page);
    }

    // Disconnect managers
    await connection.cdpManager.disconnect();
    if (connection.puppeteerManager) {
      await connection.puppeteerManager.disconnect();
    }

    // Remove from registry
    this.connections.delete(id);

    // Update active connection if we just closed it
    if (this.activeConnectionId === id) {
      const remaining = Array.from(this.connections.keys());
      this.activeConnectionId = remaining.length > 0 ? remaining[0] : null;
    }

    return true;
  }

  /**
   * Close all connections
   */
  async closeAll(): Promise<void> {
    const ids = Array.from(this.connections.keys());
    for (const id of ids) {
      await this.closeConnection(id);
    }
  }

  /**
   * Check if there are any connections
   */
  hasConnections(): boolean {
    return this.connections.size > 0;
  }

  /**
   * Get connection count
   */
  getConnectionCount(): number {
    return this.connections.size;
  }
}
