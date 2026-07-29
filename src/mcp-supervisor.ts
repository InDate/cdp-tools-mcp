#!/usr/bin/env node
/**
 * Dependency-free MCP hot-reload supervisor.
 *
 * This is the package's `bin` entry point - both this repo's own .mcp.json
 * and every other project's `npx cdp-tools-mcp@latest` launch THIS process
 * instead of the real server directly. This process keeps that stdio
 * connection alive forever and manages the real server (index.js, resolved
 * next to this file - see below) as a restartable child, so:
 * - a crash gets auto-relaunched with backoff, instead of leaving every
 *   project's MCP connection dead until a manual /mcp reconnect;
 * - in this repo specifically, a rebuild (package.json's `postbuild` script)
 *   or a manual `kill -USR2 <pid>` restarts the real server live.
 *
 * The child script path is resolved relative to THIS file's own location
 * (__dirname), not process.cwd() - process.cwd() is this repo's root when
 * launched via its own .mcp.json, but is whatever *other* project's
 * directory Claude Code happened to launch from when installed globally/via
 * npx, which has no build/index.js of its own. Same-directory resolution
 * works correctly in both cases, since index.js always ships right next to
 * this file. Override with MCP_SUPERVISOR_CHILD_SCRIPT for testing; every
 * other argv is passed straight through to the child.
 *
 * See /Users/joshua/.claude/plans/zesty-coalescing-tome.md for the full
 * design and its rationale.
 *
 * Usage: node build/mcp-supervisor.js [...extraChildArgs]
 */
import * as path from 'path';
import { fileURLToPath } from 'url';
import { getOutputPath } from './helpers/paths.js';
import { atomicWriteFile } from './atomic-write.js';
import { ChildManager } from './supervisor/child-manager.js';
import { RestartCoordinator } from './supervisor/restart-coordinator.js';
import { NdjsonReader } from './supervisor/ndjson-reader.js';
import { removeOwnPidFile } from './supervisor/pidfile.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function logStderr(message: string): void {
  process.stderr.write(`[mcp-supervisor] ${message}\n`);
}

async function main(): Promise<void> {
  const scriptPath = process.env.MCP_SUPERVISOR_CHILD_SCRIPT
    ? path.resolve(process.cwd(), process.env.MCP_SUPERVISOR_CHILD_SCRIPT)
    : path.join(__dirname, 'index.js');
  const extraArgs = process.argv.slice(2);

  const pidFilePath = getOutputPath('mcp-supervisor.pid');
  await atomicWriteFile(pidFilePath, String(process.pid));

  const childManager = new ChildManager({
    execPath: process.execPath,
    scriptPath,
    extraArgs,
    cwd: process.cwd(),
  });

  // Always points at the currently-running child's stdin, so writeToChild
  // routes to whichever process is actually alive right now.
  let currentChildStdin: NodeJS.WritableStream | null = null;

  const coordinator: RestartCoordinator = new RestartCoordinator(
    {
      writeToChild: (line) => {
        if (!currentChildStdin) {
          logStderr('Dropping message meant for child - no child is currently running');
          return;
        }
        currentChildStdin.write(line + (line.endsWith('\n') ? '' : '\n'));
      },
      writeToHost: (line) => {
        process.stdout.write(line.endsWith('\n') ? line : line + '\n');
      },
      killChild: () => childManager.kill(),
      spawnChild: () => spawnAndWireChild(),
      logStderr,
    },
    {}
  );

  function spawnAndWireChild(): void {
    const { stdout, stdin } = childManager.spawn();
    currentChildStdin = stdin;
    stdin.on('error', (err) => logStderr(`Child stdin error (ignored): ${err}`));

    const reader = new NdjsonReader();
    stdout.on('data', (chunk: Buffer) => {
      reader.push(chunk);
      for (const line of reader.readAllLines()) {
        coordinator.handleChildLine(line);
      }
    });
    stdout.on('close', () => {
      if (currentChildStdin === stdin) {
        currentChildStdin = null;
      }
      coordinator.onChildStdoutClosed();
    });
  }

  childManager.onExit(({ code, signal }) => {
    logStderr(`Child exited (code=${code}, signal=${signal})`);
    coordinator.onChildExit();
  });

  // Host (Claude Code) -> supervisor -> child
  const hostReader = new NdjsonReader();
  process.stdin.on('data', (chunk: Buffer) => {
    hostReader.push(chunk);
    for (const line of hostReader.readAllLines()) {
      coordinator.handleHostLine(line);
    }
  });

  // Manual restart trigger (also wired to package.json's `postbuild` script).
  process.on('SIGUSR2', () => {
    logStderr('Received SIGUSR2, restarting child');
    coordinator.requestRestart('signal');
  });

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logStderr(`Shutting down (${reason})`);
    coordinator.prepareForShutdown();
    try {
      await childManager.kill();
    } catch (err) {
      logStderr(`Error killing child during shutdown: ${err}`);
    }
    // Only if it is still OURS: a newer supervisor may own it by now, and
    // taking that one's pidfile away silently breaks its hot reload.
    await removeOwnPidFile(pidFilePath, process.pid);
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGHUP', () => void shutdown('SIGHUP'));
  // Claude Code exiting without sending a signal still closes its end of stdin.
  process.stdin.on('end', () => void shutdown('host stdin ended'));
  process.stdin.on('close', () => void shutdown('host stdin closed'));

  process.on('uncaughtException', (error) => {
    logStderr(`Uncaught exception: ${error?.stack || error}`);
  });
  process.on('unhandledRejection', (reason) => {
    logStderr(`Unhandled rejection: ${reason}`);
  });

  logStderr(`Starting (PID: ${process.pid}), child script: ${scriptPath}`);
  spawnAndWireChild();
}

main().catch((error) => {
  logStderr(`Fatal error during startup: ${error?.stack || error}`);
  process.exit(1);
});
