/**
 * Centralized path configuration for cdp-tools output directories
 *
 * Path hierarchy:
 * - CDP_TOOLS_DIR env var → overrides both global and working directory base
 * - Global: ~/.cdp-tools/ (servers.json, sequences, network-bodies)
 * - Working Directory: <cwd>/.cdp-tools/ if valid, else falls back to global
 * - Temp: system temp directory for ephemeral data
 */

import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { existsSync, accessSync, constants } from 'fs';

const OUTPUT_DIR = '.cdp-tools';

interface PathConfig {
  globalBase: string;
  workingDirBase: string | null; // null if cwd is invalid
  tempBase: string;
}

let pathConfig: PathConfig | null = null;

/**
 * Check if directory is a valid, writable working directory
 */
function isValidWorkingDirectory(dir: string): boolean {
  // Reject root directories (Unix: /, Windows: \, C:\, D:\, etc.)
  if (dir === '/' || dir === '\\') return false;
  if (/^[A-Za-z]:\\?$/.test(dir)) return false; // Windows drive root like C: or C:\

  // Check if directory exists and is writable
  try {
    if (!existsSync(dir)) return false;
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Initialize path configuration at startup.
 * Called automatically on first path request, but can be called explicitly for early initialization.
 */
export function initializePaths(): PathConfig {
  const envOverride = process.env.CDP_TOOLS_DIR;
  const globalBase = envOverride || join(homedir(), OUTPUT_DIR);
  const cwd = process.cwd();
  const workingDirBase = isValidWorkingDirectory(cwd)
    ? join(cwd, OUTPUT_DIR)
    : null;
  const tempBase = join(tmpdir(), 'cdp-tools');

  pathConfig = { globalBase, workingDirBase, tempBase };
  return pathConfig;
}

/**
 * Get path for user-global data (servers.json, sequences).
 * Always uses home directory or CDP_TOOLS_DIR override.
 *
 * @param segments - Path segments to join (e.g., 'servers.json')
 * @returns Full path like ~/.cdp-tools/servers.json
 */
export function getGlobalPath(...segments: string[]): string {
  if (!pathConfig) initializePaths();
  return join(pathConfig!.globalBase, ...segments);
}

/**
 * Get path for working-directory-specific data (logs, screenshots, downloads).
 * Uses cwd/.cdp-tools if cwd is valid, otherwise falls back to global.
 *
 * @param segments - Path segments to join (e.g., 'logs', 'debug.log')
 * @returns Full path like /project/.cdp-tools/logs/debug.log or ~/.cdp-tools/logs/debug.log
 */
export function getWorkingDirPath(...segments: string[]): string {
  if (!pathConfig) initializePaths();
  const base = pathConfig!.workingDirBase ?? pathConfig!.globalBase;
  return join(base, ...segments);
}

/**
 * Get config path with backwards compatibility.
 * Checks cwd first (if valid and config exists there), then global.
 *
 * @returns Path to config.json
 */
export function getConfigPath(): string {
  if (!pathConfig) initializePaths();

  // Check working directory first for backwards compatibility
  if (pathConfig!.workingDirBase) {
    const wdConfig = join(pathConfig!.workingDirBase, 'config.json');
    if (existsSync(wdConfig)) {
      return wdConfig;
    }
  }

  // Fall back to global
  return join(pathConfig!.globalBase, 'config.json');
}

/**
 * Get path for saving new config (always global for new configs).
 *
 * @returns Path to global config.json
 */
export function getConfigSavePath(): string {
  if (!pathConfig) initializePaths();
  return join(pathConfig!.globalBase, 'config.json');
}

/**
 * Get path for temporary/ephemeral data.
 * Uses system temp directory.
 *
 * @param segments - Path segments to join (e.g., 'a4-page.css')
 * @returns Full path like /tmp/cdp-tools/a4-page.css
 */
export function getTempPath(...segments: string[]): string {
  if (!pathConfig) initializePaths();
  return join(pathConfig!.tempBase, ...segments);
}

/**
 * Check if working directory storage is available (cwd is valid).
 */
export function hasWorkingDirStorage(): boolean {
  if (!pathConfig) initializePaths();
  return pathConfig!.workingDirBase !== null;
}

// Deprecated aliases for backwards compatibility
/** @deprecated Use getWorkingDirPath() */
export const getOutputPath = getWorkingDirPath;
/** @deprecated Use getGlobalPath() */
export const getHomeOutputPath = getGlobalPath;
