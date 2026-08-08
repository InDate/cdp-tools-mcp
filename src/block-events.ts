/**
 * Block event stream - one JSON line per new guard block, appended to
 * .devharness/logs/blocks.jsonl.
 *
 * Guards only surface on the *next* tool call, so a session doing unrelated
 * work never learns its dev server died until it happens to call a devharness
 * tool again. This file is the push side of that: a Claude Code Monitor can
 * `tail -f` it and get notified the moment a block appears.
 *
 * Deduplicated by key - a block that keeps firing on every subsequent tool call
 * writes one line, not one per call. The active set clears once a call gets
 * through all guards.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { getOutputPath } from './helpers/paths.js';

export type BlockGuard =
  | 'port'
  | 'breakpoint'
  | 'pendingStartup'
  | 'bug'
  | 'duplicateSession';

/**
 * Identity and summary of a block, attached to the BlockingResponse that
 * carries it so index.ts can log it without re-deriving the reason.
 */
export interface BlockEventInfo {
  guard: BlockGuard;
  /** Dedupe identity - same key while the same block persists. */
  key: string;
  /** One-line summary of what is blocked. */
  detail: string;
  /** The call that clears it. */
  resolve: string;
}

// Keys currently blocking. Written once per key, cleared when a tool call
// passes every guard.
const activeKeys = new Set<string>();

function getBlockFile(): string {
  return join(getOutputPath('logs'), 'blocks.jsonl');
}

/**
 * Append a block event if this block is new. No-op for a block already logged.
 */
export async function recordBlockEvent(
  info: BlockEventInfo | undefined,
  tool: string
): Promise<void> {
  if (!info) return;

  const dedupeKey = `${info.guard}:${info.key}`;
  if (activeKeys.has(dedupeKey)) {
    return;
  }
  activeKeys.add(dedupeKey);

  const line = JSON.stringify({
    ts: new Date().toISOString(),
    guard: info.guard,
    tool,
    detail: info.detail,
    resolve: info.resolve,
  });

  try {
    const dir = getOutputPath('logs');
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(getBlockFile(), line + '\n');
  } catch (error) {
    // Never let the event stream break the block itself
    console.error(`[BlockEvents] Failed to write block event: ${error}`);
  }
}

/**
 * Forget every active block. Called when a tool call clears all guards, so a
 * block that recurs later gets logged again.
 */
export function clearBlockEvents(): void {
  activeKeys.clear();
}

/**
 * Test/debug helper - which blocks are currently deduped out.
 */
export function getActiveBlockKeys(): string[] {
  return [...activeKeys];
}

export function getBlockEventFilePath(): string {
  return getBlockFile();
}
