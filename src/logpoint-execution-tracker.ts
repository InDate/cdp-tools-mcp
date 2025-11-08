/**
 * Logpoint Execution Tracker
 * Monitors logpoint executions and enforces execution limits
 */

import type { StoredConsoleMessage } from './console-monitor.js';

export interface LogpointMetadata {
  breakpointId: string;
  url: string;
  lineNumber: number;
  logMessage: string;
  maxExecutions: number;
  executionCount: number;
  logs: StoredConsoleMessage[];
}

export type LimitExceededCallback = (metadata: LogpointMetadata) => void;

export class LogpointExecutionTracker {
  private logpoints: Map<string, LogpointMetadata> = new Map();
  private onLimitExceeded: LimitExceededCallback | null = null;

  /**
   * Register a new logpoint for tracking
   */
  registerLogpoint(
    breakpointId: string,
    url: string,
    lineNumber: number,
    logMessage: string,
    maxExecutions: number
  ): void {
    this.logpoints.set(breakpointId, {
      breakpointId,
      url,
      lineNumber,
      logMessage,
      maxExecutions,
      executionCount: 0,
      logs: [],
    });
  }

  /**
   * Unregister a logpoint
   */
  unregisterLogpoint(breakpointId: string): void {
    this.logpoints.delete(breakpointId);
  }

  /**
   * Reset the execution counter for a logpoint
   */
  resetCounter(breakpointId: string): void {
    const metadata = this.logpoints.get(breakpointId);
    if (metadata) {
      metadata.executionCount = 0;
      metadata.logs = [];
    }
  }

  /**
   * Get metadata for a specific logpoint
   */
  getLogpoint(breakpointId: string): LogpointMetadata | undefined {
    return this.logpoints.get(breakpointId);
  }

  /**
   * Get all registered logpoints
   */
  getAllLogpoints(): LogpointMetadata[] {
    return Array.from(this.logpoints.values());
  }

  /**
   * Set the callback to invoke when a logpoint exceeds its limit
   */
  setLimitExceededCallback(callback: LimitExceededCallback): void {
    this.onLimitExceeded = callback;
  }

  /**
   * Handle a console message - check if it's from a logpoint
   * This should be called by ConsoleMonitor when a message is added
   */
  handleConsoleMessage(message: StoredConsoleMessage): void {
    // Check if this is a logpoint message
    if (!message.text.startsWith('[Logpoint]')) {
      return;
    }

    // Try to match the message to a registered logpoint
    // We'll match by the location (url and line number)
    if (!message.location) {
      return;
    }

    // Find the logpoint that matches this location
    for (const metadata of this.logpoints.values()) {
      // Compare URL and line number
      // Note: location.lineNumber is 0-based in CDP, but we store 1-based
      if (
        this.urlsMatch(message.location.url, metadata.url) &&
        message.location.lineNumber === metadata.lineNumber - 1
      ) {
        // Increment execution count
        metadata.executionCount++;

        // Store the log message
        metadata.logs.push(message);

        // Check if limit exceeded
        if (metadata.executionCount >= metadata.maxExecutions) {
          // Invoke callback if set
          if (this.onLimitExceeded) {
            this.onLimitExceeded(metadata);
          }
        }

        break; // Only match to one logpoint
      }
    }
  }

  /**
   * Helper to match URLs (handle file:// vs http:// and normalization)
   */
  private urlsMatch(url1: string, url2: string): boolean {
    // Normalize URLs for comparison
    const normalize = (url: string) => {
      // Remove trailing slashes
      return url.replace(/\/$/, '');
    };

    return normalize(url1) === normalize(url2);
  }

  /**
   * Clear all tracked logpoints
   */
  clear(): void {
    this.logpoints.clear();
  }
}
