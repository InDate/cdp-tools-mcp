/**
 * Centralized path configuration for cdp-tools output directories
 *
 * All data defaults to working directory (<cwd>/.cdp-tools/).
 * Use global: true to save to ~/.cdp-tools/ instead.
 * If cwd is invalid (e.g., "/"), falls back to global automatically.
 */

import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { existsSync, accessSync, constants } from 'fs';
import { z } from 'zod';

const OUTPUT_DIR = '.cdp-tools';

const pathOptionsSchema = z.object({
  global: z.boolean().optional(),
}).strict();

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
 * Override the working-directory base at runtime.
 * Needed because MCP clients (e.g. Claude Desktop) spawn one long-lived
 * server process shared across projects — process.cwd() reflects wherever
 * the client happened to launch from, not the project the user is in.
 *
 * @throws if dir does not exist or is not writable
 */
export function setWorkingDirOverride(dir: string): void {
  if (!isValidWorkingDirectory(dir)) {
    throw new Error(`Not a valid, writable directory: ${dir}`);
  }
  if (!pathConfig) initializePaths();
  pathConfig!.workingDirBase = join(dir, OUTPUT_DIR);
}

/**
 * Get path for cdp-tools data.
 * Defaults to working directory, use global: true for ~/.cdp-tools/
 *
 * @param segments - Path segments to join (e.g., 'logs', 'debug.log')
 * @param options - { global: true } to use ~/.cdp-tools/ instead of cwd
 * @returns Full path like /project/.cdp-tools/logs/debug.log
 */
export function getOutputPath(
  ...args: [...string[]] | [...string[], z.infer<typeof pathOptionsSchema>]
): string {
  if (!pathConfig) initializePaths();

  // Parse arguments - last arg might be options object
  let segments: string[];
  let global = false;

  const lastArg = args[args.length - 1];
  if (lastArg && typeof lastArg === 'object' && !Array.isArray(lastArg)) {
    // Validate options with Zod - throws on invalid/unknown properties
    const options = pathOptionsSchema.parse(lastArg);
    segments = args.slice(0, -1) as string[];
    global = options.global ?? false;
  } else {
    segments = args as string[];
  }

  // Determine base path
  let base: string;
  if (global) {
    base = pathConfig!.globalBase;
  } else {
    base = pathConfig!.workingDirBase ?? pathConfig!.globalBase;
  }

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
 * Get path for saving new config.
 *
 * @param options - { global: true } to save to ~/.cdp-tools/ (default: working directory)
 * @returns Path to config.json
 */
export function getConfigSavePath(options?: { global?: boolean }): string {
  if (!pathConfig) initializePaths();
  const global = options?.global ?? false;

  if (global) {
    return join(pathConfig!.globalBase, 'config.json');
  }

  const base = pathConfig!.workingDirBase ?? pathConfig!.globalBase;
  return join(base, 'config.json');
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
/** @deprecated Use getOutputPath() */
export function getWorkingDirPath(...segments: string[]): string {
  return getOutputPath(...segments);
}

/** @deprecated Use getOutputPath(...segments, { global: true }) */
export function getGlobalPath(...segments: string[]): string {
  return getOutputPath(...segments, { global: true });
}

/** @deprecated Use getOutputPath() */
export const getHomeOutputPath = getGlobalPath;
