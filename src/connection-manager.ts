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
  reference?: string; // User-provided tab reference (e.g., "agent1-wikipedia")
  pageIndex?: number; // Index of the page/tab in the browser
}

// Browser instance tracking (multiple connections can share one browser)
interface BrowserInstance {
  host: string;
  port: number;
  connectionIds: string[]; // Connections using this browser
}

export class ConnectionManager {
  private connections: Map<string, Connection> = new Map();
  private browsers: Map<string, BrowserInstance> = new Map(); // Key: "host:port"
  private activeConnectionId: string | null = null;
  private connectionCounter = 0;

  /**
   * Create a new connection (tab)
   */
  createConnection(
    cdpManager: CDPManager,
    puppeteerManager?: PuppeteerManager,
    consoleMonitor?: ConsoleMonitor,
    networkMonitor?: NetworkMonitor,
    host: string = 'localhost',
    port: number = 9222,
    reference?: string,
    pageIndex?: number
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
      reference,
      pageIndex,
    };

    this.connections.set(id, connection);

    // Track browser instance
    const browserKey = `${host}:${port}`;
    if (!this.browsers.has(browserKey)) {
      this.browsers.set(browserKey, {
        host,
        port,
        connectionIds: [id],
      });
    } else {
      this.browsers.get(browserKey)!.connectionIds.push(id);
    }

    // Set as active if it's the first connection
    if (this.connections.size === 1) {
      this.activeConnectionId = id;
    }

    return id;
  }

  /**
   * Check if a browser instance exists at this host:port
   */
  hasBrowser(host: string, port: number): boolean {
    const browserKey = `${host}:${port}`;
    return this.browsers.has(browserKey);
  }

  /**
   * Get all connections for a specific browser
   */
  getConnectionsForBrowser(host: string, port: number): Connection[] {
    const browserKey = `${host}:${port}`;
    const browser = this.browsers.get(browserKey);
    if (!browser) {
      return [];
    }
    return browser.connectionIds
      .map(id => this.connections.get(id))
      .filter((conn): conn is Connection => conn !== undefined);
  }

  /**
   * Update tab reference for a connection
   */
  updateReference(connectionId: string, reference: string): boolean {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return false;
    }
    connection.reference = reference;
    return true;
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
   * Close a connection (tab)
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

      // Close the page/tab
      try {
        await page.close();
      } catch (error) {
        console.error(`[ConnectionManager] Error closing page: ${error}`);
      }
    }

    // Disconnect managers only for this connection
    await connection.cdpManager.disconnect();
    // Note: Don't disconnect puppeteerManager as it's shared across tabs

    // Remove from browser tracking
    const browserKey = `${connection.host}:${connection.port}`;
    const browser = this.browsers.get(browserKey);
    if (browser) {
      browser.connectionIds = browser.connectionIds.filter(connId => connId !== id);
      // If no more connections, remove browser entry
      if (browser.connectionIds.length === 0) {
        this.browsers.delete(browserKey);
      }
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
