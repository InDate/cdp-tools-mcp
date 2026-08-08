#!/usr/bin/env node

/**
 * postbuild hook: signals a running mcp-supervisor (if any) to restart the
 * real MCP server child, so `npm run build` hot-reloads a live Claude Code
 * connection instead of requiring a manual /mcp reconnect.
 *
 * A no-op if no supervisor is running (e.g. CI, or a plain build with no live
 * session attached) - this must never fail the build. It does SAY so, though:
 * a silent no-op is indistinguishable from a successful reload, so a build that
 * never reached the running server looks exactly like one that did, and you
 * debug stale code believing it is current.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

// Mirrors resolveStateDir in src/helpers/paths.ts: `.cdp-tools` is the pre-0.9.0
// name, kept as a fallback for a checkout the server has not migrated yet.
const candidatePidFiles = ['.devharness', '.cdp-tools'].map(
  (dir) => join(process.cwd(), dir, 'mcp-supervisor.pid')
);
const note = (message) => console.error(`[signal-supervisor] ${message}`);
const RECONNECT_HINT = 'run /mcp in Claude Code to pick up this build';

let pid;
let pidFilePath;
for (const candidate of candidatePidFiles) {
  try {
    pid = parseInt(readFileSync(candidate, 'utf-8').trim(), 10);
    pidFilePath = candidate;
    break;
  } catch {
    // Try the next location
  }
}

if (pidFilePath === undefined) {
  note(`No pidfile at ${candidatePidFiles.join(' or ')} - nothing to reload (${RECONNECT_HINT}).`);
  process.exit(0);
}

if (!Number.isInteger(pid) || pid <= 0) {
  note(`Pidfile holds "${pid}", which is not a pid - nothing to reload (${RECONNECT_HINT}).`);
  process.exit(0);
}

try {
  process.kill(pid, 'SIGUSR2');
  note(`Sent SIGUSR2 to mcp-supervisor (PID ${pid})`);
} catch (err) {
  note(
    err?.code === 'ESRCH'
      ? `Supervisor PID ${pid} is no longer running - nothing to reload (${RECONNECT_HINT}).`
      : `Could not signal supervisor PID ${pid}: ${err?.message ?? err} (${RECONNECT_HINT}).`
  );
}
