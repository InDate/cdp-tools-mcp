/**
 * Centralized path configuration for cdp-tools output directories
 */

import { join } from 'path';
import { homedir } from 'os';

/**
 * Default output directory name for all cdp-tools artifacts
 */
const DEFAULT_OUTPUT_DIR = '.cdp-tools';

/**
 * Current output directory - can be overridden by config
 */
let outputDir = DEFAULT_OUTPUT_DIR;

/**
 * Set the output directory name (called from config after load)
 */
export function setOutputDir(dir: string): void {
  outputDir = dir;
}

/**
 * Get the current output directory name
 */
export function getOutputDir(): string {
  return outputDir;
}

/**
 * Get the full path to an output location within the cdp-tools output directory.
 * Uses current working directory as base.
 *
 * @param segments - Path segments to join (e.g., 'logs', 'debug.log')
 * @returns Full path like /path/to/project/.cdp-tools/logs/debug.log
 */
export function getOutputPath(...segments: string[]): string {
  return join(process.cwd(), outputDir, ...segments);
}

/**
 * Get the full path to an output location within the user's home directory.
 * Used for global/shared data like network bodies.
 *
 * @param segments - Path segments to join (e.g., 'network-bodies')
 * @returns Full path like /Users/user/.cdp-tools/network-bodies
 */
export function getHomeOutputPath(...segments: string[]): string {
  return join(homedir(), outputDir, ...segments);
}
