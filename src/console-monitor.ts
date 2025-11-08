/**
 * Console Monitor
 * Tracks console messages from the browser
 */

import { Page, ConsoleMessage, JSHandle } from 'puppeteer-core';

export interface StoredConsoleMessage {
  id: string;
  type: string;
  text: string;
  args: any[];
  location?: {
    url: string;
    lineNumber: number;
    columnNumber: number;
  };
  stackTrace?: any;
  timestamp: number;
}

export class ConsoleMonitor {
  private messages: StoredConsoleMessage[] = [];
  private messageIdCounter = 0;
  private maxMessages = 1000; // Keep last 1000 messages
  private isMonitoring = false;
  private messageCallbacks: Array<(message: StoredConsoleMessage) => void> = [];

  /**
   * Start monitoring console messages on a page
   */
  startMonitoring(page: Page): void {
    // Remove any existing listeners first to avoid duplicates
    page.removeAllListeners('console');
    page.removeAllListeners('pageerror');

    // Attach console listener
    page.on('console', (msg: ConsoleMessage) => {
      this.addMessage(msg);
    });

    // Attach uncaught exception listener
    page.on('pageerror', (error: Error) => {
      this.addPageError(error);
    });

    this.isMonitoring = true;
  }

  /**
   * Stop monitoring
   */
  stopMonitoring(page: Page): void {
    page.removeAllListeners('console');
    page.removeAllListeners('pageerror');
    this.isMonitoring = false;
  }

  /**
   * Add a page error (uncaught exception)
   */
  private addPageError(error: Error): void {
    const id = `console-${this.messageIdCounter++}`;

    const storedMessage: StoredConsoleMessage = {
      id,
      type: 'error',
      text: `Uncaught ${error.message}`,
      args: [],
      stackTrace: error.stack ? error.stack.split('\n').map(line => ({ description: line })) : undefined,
      timestamp: Date.now(),
    };

    this.messages.push(storedMessage);

    // Keep only last N messages
    if (this.messages.length > this.maxMessages) {
      this.messages.shift();
    }

    // Notify callbacks
    for (const callback of this.messageCallbacks) {
      try {
        callback(storedMessage);
      } catch (error) {
        // Silently ignore callback errors to prevent disruption
        console.error('[ConsoleMonitor] Error in message callback:', error);
      }
    }
  }

  /**
   * Serialize a JSHandle to a JSON-safe value with cycle detection
   */
  private async serializeJSHandle(handle: JSHandle, maxDepth: number = 3, seen: WeakSet<any> = new WeakSet()): Promise<any> {
    if (maxDepth <= 0) {
      return '[Max depth reached]';
    }

    try {
      // Try to get JSON value first
      const jsonValue = await handle.jsonValue();

      // Handle primitives
      if (jsonValue === null || typeof jsonValue !== 'object') {
        return jsonValue;
      }

      // Check for cycles
      if (seen.has(jsonValue)) {
        return '[Circular]';
      }
      seen.add(jsonValue);

      // Handle arrays
      if (Array.isArray(jsonValue)) {
        return await Promise.all(
          jsonValue.slice(0, 100).map(async (item) => {
            if (item && typeof item === 'object') {
              return await this.serializeValue(item, maxDepth - 1, seen);
            }
            return item;
          })
        );
      }

      // Handle objects
      const result: Record<string, any> = {};
      const keys = Object.keys(jsonValue).slice(0, 50); // Limit to 50 properties
      for (const key of keys) {
        const value = (jsonValue as any)[key];
        if (value && typeof value === 'object') {
          result[key] = await this.serializeValue(value, maxDepth - 1, seen);
        } else {
          result[key] = value;
        }
      }
      return result;
    } catch (error) {
      // If serialization fails, try to get a description
      try {
        const properties = await handle.getProperties();
        if (properties.size === 0) {
          return handle.toString();
        }

        const result: any = {};
        let count = 0;
        for (const [key, valueHandle] of properties) {
          if (count++ >= 10) break; // Limit properties for complex objects
          if (key.startsWith('Symbol(')) continue; // Skip symbols

          try {
            result[key] = await valueHandle.jsonValue();
          } catch {
            result[key] = valueHandle.toString();
          }
        }
        return result;
      } catch {
        return handle.toString();
      }
    }
  }

  /**
   * Helper to serialize nested values
   */
  private async serializeValue(value: any, maxDepth: number, seen: WeakSet<any>): Promise<any> {
    if (maxDepth <= 0) {
      return '[Max depth reached]';
    }

    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value !== 'object') {
      return value;
    }

    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);

    if (Array.isArray(value)) {
      return value.slice(0, 100).map(item => {
        if (item && typeof item === 'object') {
          return this.serializeValue(item, maxDepth - 1, seen);
        }
        return item;
      });
    }

    const result: Record<string, any> = {};
    const keys = Object.keys(value).slice(0, 50);
    for (const key of keys) {
      const val = (value as any)[key];
      if (val && typeof val === 'object') {
        result[key] = await this.serializeValue(val, maxDepth - 1, seen);
      } else {
        result[key] = val;
      }
    }
    return result;
  }

  /**
   * Add a console message
   */
  private async addMessage(msg: ConsoleMessage): Promise<void> {
    const id = `console-${this.messageIdCounter++}`;

    // Get message arguments with deep serialization
    const args = await Promise.all(
      msg.args().map(async (arg) => {
        return await this.serializeJSHandle(arg);
      })
    );

    const location = msg.location();

    const storedMessage: StoredConsoleMessage = {
      id,
      type: msg.type(),
      text: msg.text(),
      args,
      location: location ? {
        url: location.url || '',
        lineNumber: location.lineNumber || 0,
        columnNumber: location.columnNumber || 0,
      } : undefined,
      stackTrace: msg.stackTrace(),
      timestamp: Date.now(),
    };

    this.messages.push(storedMessage);

    // Keep only last N messages
    if (this.messages.length > this.maxMessages) {
      this.messages.shift();
    }

    // Notify callbacks
    for (const callback of this.messageCallbacks) {
      try {
        callback(storedMessage);
      } catch (error) {
        // Silently ignore callback errors to prevent disruption
        console.error('[ConsoleMonitor] Error in message callback:', error);
      }
    }
  }

  /**
   * Get all messages
   */
  getMessages(filter?: { type?: string; limit?: number; offset?: number }): StoredConsoleMessage[] {
    let filtered = this.messages;

    // Filter by type
    if (filter?.type) {
      filtered = filtered.filter(msg => msg.type === filter.type);
    }

    // Apply offset and limit
    const offset = filter?.offset || 0;
    const limit = filter?.limit || filtered.length;

    return filtered.slice(offset, offset + limit);
  }

  /**
   * Get a message by ID
   */
  getMessage(id: string): StoredConsoleMessage | undefined {
    return this.messages.find(msg => msg.id === id);
  }

  /**
   * Clear all messages
   */
  clear(): void {
    this.messages = [];
    // Don't reset counter - prevents ID collisions after clear
  }

  /**
   * Get message count
   */
  getCount(type?: string): number {
    if (type) {
      return this.messages.filter(msg => msg.type === type).length;
    }
    return this.messages.length;
  }

  /**
   * Get the most recent N messages
   */
  getRecentMessages(count: number = 50, type?: string): StoredConsoleMessage[] {
    let filtered = this.messages;

    if (type) {
      filtered = filtered.filter(msg => msg.type === type);
    }

    return filtered.slice(-count); // Last N messages
  }

  /**
   * Get all messages without pagination
   */
  getAllMessages(type?: string): StoredConsoleMessage[] {
    if (type) {
      return this.messages.filter(msg => msg.type === type);
    }
    return [...this.messages];
  }

  /**
   * Check if monitoring
   */
  isActive(): boolean {
    return this.isMonitoring;
  }

  /**
   * Register a callback to be invoked when a console message is added
   */
  onMessage(callback: (message: StoredConsoleMessage) => void): void {
    this.messageCallbacks.push(callback);
  }

  /**
   * Remove a callback
   */
  removeMessageCallback(callback: (message: StoredConsoleMessage) => void): void {
    const index = this.messageCallbacks.indexOf(callback);
    if (index !== -1) {
      this.messageCallbacks.splice(index, 1);
    }
  }
}
