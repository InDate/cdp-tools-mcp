/**
 * Console Monitor
 * Tracks console messages from the browser
 */

import { Page, ConsoleMessage } from 'puppeteer-core';

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

  /**
   * Start monitoring console messages on a page
   */
  startMonitoring(page: Page): void {
    if (this.isMonitoring) {
      return;
    }

    page.on('console', (msg: ConsoleMessage) => {
      this.addMessage(msg);
    });

    this.isMonitoring = true;
  }

  /**
   * Stop monitoring
   */
  stopMonitoring(page: Page): void {
    page.removeAllListeners('console');
    this.isMonitoring = false;
  }

  /**
   * Add a console message
   */
  private async addMessage(msg: ConsoleMessage): Promise<void> {
    const id = `console-${this.messageIdCounter++}`;

    // Get message arguments as JSON
    const args = await Promise.all(
      msg.args().map(async (arg) => {
        try {
          return await arg.jsonValue();
        } catch {
          return arg.toString();
        }
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
    this.messageIdCounter = 0;
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
   * Check if monitoring
   */
  isActive(): boolean {
    return this.isMonitoring;
  }
}
