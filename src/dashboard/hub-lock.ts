/**
 * Hub Lock Management
 * Manages the dashboard.lock file for hub singleton election
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, renameSync } from 'fs';
import { dirname } from 'path';
import { getOutputPath } from '../helpers/paths.js';
import type { HubLockData } from './types.js';

const LOCK_FILE = 'dashboard.lock';
const DEFAULT_PORT = 9500;
const MAX_PORT_ATTEMPTS = 10;

export function getLockPath(): string {
  return getOutputPath(LOCK_FILE, { global: true });
}

export function readLock(): HubLockData | null {
  const lockPath = getLockPath();
  if (!existsSync(lockPath)) {
    return null;
  }

  try {
    const content = readFileSync(lockPath, 'utf-8');
    return JSON.parse(content) as HubLockData;
  } catch {
    return null;
  }
}

export function writeLock(data: HubLockData): void {
  const lockPath = getLockPath();
  const dir = dirname(lockPath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Atomic write: write to temp file then rename
  const tempPath = `${lockPath}.${process.pid}.tmp`;
  writeFileSync(tempPath, JSON.stringify(data, null, 2));

  // On most systems, rename is atomic
  renameSync(tempPath, lockPath);
}

export function removeLock(): void {
  const lockPath = getLockPath();
  try {
    unlinkSync(lockPath);
  } catch {
    // Lock already removed or doesn't exist
  }
}

export function isLockStale(lock: HubLockData): boolean {
  // Check if the process is still running
  try {
    process.kill(lock.pid, 0);
    return false; // Process exists
  } catch {
    return true; // Process doesn't exist
  }
}

export async function isHubAlive(lock: HubLockData, timeout = 2000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(`http://localhost:${lock.port}/health`, {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    return response.ok;
  } catch {
    return false;
  }
}

export function getNextAvailablePort(startPort = DEFAULT_PORT): number {
  // Just return the start port - actual availability is checked when binding
  return startPort;
}

export { DEFAULT_PORT, MAX_PORT_ATTEMPTS };
