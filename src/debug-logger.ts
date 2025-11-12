/**
 * Simple debug logger for troubleshooting
 * Writes to .claude/logs/debug.log when enabled
 */

import { promises as fs } from 'fs';
import { join } from 'path';

const LOG_DIR = join(process.cwd(), '.claude', 'logs');
const LOG_FILE = join(LOG_DIR, 'debug.log');

// Global debug state - can be toggled via MCP tool
let debugEnabled = false;

/**
 * Enable debug logging
 */
export function enableDebugLogging(): void {
  debugEnabled = true;
  console.error('[DebugLogger] Debug logging enabled');
}

/**
 * Disable debug logging
 */
export function disableDebugLogging(): void {
  debugEnabled = false;
  console.error('[DebugLogger] Debug logging disabled');
}

/**
 * Check if debug logging is enabled
 */
export function isDebugEnabled(): boolean {
  return debugEnabled;
}

/**
 * Write a debug log entry (only if debug logging is enabled)
 * Format: [TIMESTAMP] [MODULE] message
 */
export async function debugLog(module: string, message: string): Promise<void> {
  if (!debugEnabled) {
    return; // Skip logging if disabled
  }

  try {
    // Ensure log directory exists
    await fs.mkdir(LOG_DIR, { recursive: true });

    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] [${module}] ${message}\n`;

    // Append to log file
    await fs.appendFile(LOG_FILE, logEntry);

    // Also write to stderr for immediate visibility
    console.error(logEntry.trim());
  } catch (error) {
    // Don't let logging failures crash the server
    console.error(`[DebugLogger] Failed to write log: ${error}`);
  }
}
