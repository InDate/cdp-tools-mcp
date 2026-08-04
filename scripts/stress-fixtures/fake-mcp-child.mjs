#!/usr/bin/env node
/**
 * A minimal stand-in for the real MCP server (build/index.js), used by
 * scripts/stress-suspend.mjs via MCP_SUPERVISOR_CHILD_SCRIPT.
 *
 * The suspend/resume state machine lives in the supervisor, not the server, so
 * most of the stress scenarios only need a child that speaks JSON-RPC and can
 * be told to misbehave on demand. Using this instead of the real server keeps
 * a 200-cycle race loop to seconds instead of minutes, and makes "did the
 * supervisor do the right thing" the only variable.
 *
 * Modes (argv, space separated):
 *   ignore-suspend  - never exits on SIGUSR2, forcing the kill escalation path
 *   slow-suspend=N  - takes N ms to release before exiting on SIGUSR2
 *   grandchild      - spawns a detached sleeper in its process group, standing
 *                     in for a Chrome or dev server the real child holds
 *   slow-start=N    - waits N ms before answering anything
 */
import { spawn } from 'child_process';

const modes = process.argv.slice(2);
const has = (name) => modes.includes(name);
const valueOf = (prefix, fallback) => {
  const found = modes.find((m) => m.startsWith(`${prefix}=`));
  return found ? Number(found.slice(prefix.length + 1)) : fallback;
};

const slowStartMs = valueOf('slow-start', 0);
const slowSuspendMs = valueOf('slow-suspend', 0);

let grandchild = null;
if (has('grandchild')) {
  // Inherits this process's group, so a group-wide SIGKILL should take it too.
  grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' });
  process.stderr.write(`[fake-child] grandchild pid ${grandchild.pid}\n`);
}

process.stderr.write(`[fake-child] ready (pid ${process.pid}, modes: ${modes.join(',') || 'none'})\n`);

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');

let buffer = '';
process.stdin.on('data', async (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id === undefined) continue; // notification

    if (slowStartMs > 0) await new Promise((r) => setTimeout(r, slowStartMs));

    if (message.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'fake-mcp-child', version: '0.0.0' },
        },
      });
    } else if (message.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'noop', description: 'noop', inputSchema: { type: 'object' } }] } });
    } else {
      // Echo the pid so the harness can tell which child answered.
      send({ jsonrpc: '2.0', id: message.id, result: { pid: process.pid } });
    }
  }
});

if (has('ignore-suspend')) {
  process.on('SIGUSR2', () => {
    process.stderr.write('[fake-child] ignoring SIGUSR2\n');
  });
} else {
  process.on('SIGUSR2', () => {
    setTimeout(() => {
      if (grandchild) {
        try {
          process.kill(grandchild.pid, 'SIGTERM');
        } catch {
          // already gone
        }
      }
      process.exit(0);
    }, slowSuspendMs);
  });
}

process.on('SIGTERM', () => process.exit(0));

// The supervisor dying closes this pipe; without this the fixture would outlive
// it as an orphan, which is exactly what the harness is meant to catch.
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));

// Stay alive until signalled.
setInterval(() => {}, 60_000);
