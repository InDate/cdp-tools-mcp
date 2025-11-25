/**
 * Simple debug logger for troubleshooting
 * Writes to .cdp-tools/logs/debug.log when enabled
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { getOutputPath } from './helpers/paths.js';

const LOG_DIR = getOutputPath('logs');
const LOG_FILE = join(LOG_DIR, 'debug.log');

// Global debug state - can be toggled via MCP tool
let debugEnabled = false;

// Startup metrics storage - captured during startup, logged when debug is enabled
interface StartupMetrics {
  totalMs: number;
  importMs: number;
  portReservationMs: number;
  portAttempts: number;
  serverCreationMs: number;
  toolRegistrationMs: number;
  transportMs: number;
  capturedAt: string;
}

let startupMetrics: StartupMetrics | null = null;

/**
 * Store startup metrics for later logging
 */
export function setStartupMetrics(metrics: StartupMetrics): void {
  startupMetrics = metrics;
}

/**
 * Get stored startup metrics
 */
export function getStartupMetrics(): StartupMetrics | null {
  return startupMetrics;
}

/**
 * Enable debug logging
 */
export async function enableDebugLogging(): Promise<void> {
  debugEnabled = true;
  console.error('[DebugLogger] Debug logging enabled');

  // Log startup metrics if available
  if (startupMetrics) {
    await debugLog('startup', `=== Startup metrics (captured at ${startupMetrics.capturedAt}) ===`);
    await debugLog('startup', `Total startup time: ${startupMetrics.totalMs}ms`);
    await debugLog('startup', `  - Imports: ${startupMetrics.importMs}ms`);
    await debugLog('startup', `  - Port reservation: ${startupMetrics.portReservationMs}ms (${startupMetrics.portAttempts} attempt(s))`);
    await debugLog('startup', `  - Server creation: ${startupMetrics.serverCreationMs}ms`);
    await debugLog('startup', `  - Tool registration: ${startupMetrics.toolRegistrationMs}ms`);
    await debugLog('startup', `  - Transport: ${startupMetrics.transportMs}ms`);
  }
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
