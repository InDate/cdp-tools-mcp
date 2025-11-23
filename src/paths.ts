/**
 * Centralized path configuration for cdp-tools output directories
 */

import { join } from 'path';
import { homedir } from 'os';

/**
 * Base output directory name for all cdp-tools artifacts
 */
export const OUTPUT_DIR = '.cdp-tools';

/**
 * Get the full path to an output location within the cdp-tools output directory.
 * Uses current working directory as base.
 *
 * @param segments - Path segments to join (e.g., 'logs', 'debug.log')
 * @returns Full path like /path/to/project/.cdp-tools/logs/debug.log
 */
export function getOutputPath(...segments: string[]): string {
  return join(process.cwd(), OUTPUT_DIR, ...segments);
}

/**
 * Get the full path to an output location within the user's home directory.
 * Used for global/shared data like network bodies.
 *
 * @param segments - Path segments to join (e.g., 'network-bodies')
 * @returns Full path like /Users/user/.cdp-tools/network-bodies
 */
export function getHomeOutputPath(...segments: string[]): string {
  return join(homedir(), OUTPUT_DIR, ...segments);
}
