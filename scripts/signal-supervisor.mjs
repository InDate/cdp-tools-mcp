#!/usr/bin/env node

/**
 * postbuild hook: signals a running mcp-supervisor (if any) to restart the
 * real MCP server child, so `npm run build` hot-reloads a live Claude Code
 * connection instead of requiring a manual /mcp reconnect.
 *
 * Silently a no-op if no supervisor is running (e.g. CI, or a plain build
 * with no live session attached) - this must never fail the build.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const pidFilePath = join(process.cwd(), '.cdp-tools', 'mcp-supervisor.pid');

try {
  const pid = parseInt(readFileSync(pidFilePath, 'utf-8').trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    process.exit(0);
  }
  process.kill(pid, 'SIGUSR2');
  console.error(`[signal-supervisor] Sent SIGUSR2 to mcp-supervisor (PID ${pid})`);
} catch {
  // No pidfile, stale pid, or process not running - nothing to signal.
}
