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
 *   or a manual `kill -USR2 <pid>` restarts the real server live;
 * - an idle session's server can be dropped entirely - along with its Chrome
 *   instances, dev servers and monitor buffers - while this process keeps the
 *   client's connection alive and respawns on the next request (issue #138);
 * - a tree whose client is gone shuts itself down instead of living for days.
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
import * as os from 'os';
import { fileURLToPath } from 'url';
import { getOutputPath, getConfigPath } from './helpers/paths.js';
import { atomicWriteFile } from './atomic-write.js';
import { ChildManager } from './supervisor/child-manager.js';
import { RestartCoordinator } from './supervisor/restart-coordinator.js';
import { NdjsonReader } from './supervisor/ndjson-reader.js';
import { removeOwnPidFile } from './supervisor/pidfile.js';
import { ClientWatcher } from './supervisor/client-watcher.js';
import { readSupervisorSessionConfig } from './supervisor/idle-config.js';

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

  // Overridable so the stress harness can watch the escalation path without
  // sitting out the full grace period (scripts/stress-suspend.mjs).
  const suspendGraceMs = Number(process.env.CDP_TOOLS_SUSPEND_GRACE_MS);

  const childManager = new ChildManager({
    execPath: process.execPath,
    scriptPath,
    extraArgs,
    cwd: process.cwd(),
    suspendGraceMs: Number.isFinite(suspendGraceMs) && suspendGraceMs > 0 ? suspendGraceMs : undefined,
  });

  // Always points at the currently-running child's stdin, so writeToChild
  // routes to whichever process is actually alive right now.
  let currentChildStdin: NodeJS.WritableStream | null = null;

  // Last time this session did anything at all, in either direction - what the
  // idle-suspend timer measures against.
  let lastActivityAt = Date.now();

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
        // Traffic in either direction means the session is working, so a tool
        // call that runs longer than the idle threshold isn't suspended the
        // moment it finally answers.
        lastActivityAt = Date.now();
        process.stdout.write(line.endsWith('\n') ? line : line + '\n');
      },
      killChild: () => childManager.kill(),
      suspendChild: () => childManager.suspend(),
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
      lastActivityAt = Date.now();
      coordinator.handleHostLine(line);
    }
  });

  const sessionConfig = readSupervisorSessionConfig({
    configPath: getConfigPath(),
    globalConfigPath: path.join(os.homedir(), '.cdp-tools', 'config.json'),
  });

  // Suspend an idle session. The editor window this was launched from is often
  // left open for days; without this the child sits on its Chrome instances,
  // dev servers and monitor buffers for all of that time (issue #138). The
  // supervisor itself stays on the host's stdio, so the connection survives
  // and the next request spawns a fresh child.
  let idleCheckTimer: ReturnType<typeof setInterval> | null = null;
  if (sessionConfig.idleSuspendMinutes > 0) {
    const idleThresholdMs = sessionConfig.idleSuspendMinutes * 60_000;
    // Quarter of the threshold, so the suspend lands within ~25% of it, but
    // never more often than every 5 minutes for the long thresholds that are
    // the normal case. The 1s floor only matters for the very short thresholds
    // used in testing.
    const checkIntervalMs = Math.max(1_000, Math.min(idleThresholdMs / 4, 5 * 60_000));
    logStderr(`Idle suspend after ${sessionConfig.idleSuspendMinutes} minute(s) without host activity`);

    idleCheckTimer = setInterval(() => {
      if (!childManager.isRunning()) return;
      const idleMs = Date.now() - lastActivityAt;
      if (idleMs < idleThresholdMs) return;
      coordinator.suspend(`idle for ${Math.round(idleMs / 60_000)} minute(s)`);
    }, checkIntervalMs);
    idleCheckTimer.unref?.();
  } else {
    logStderr('Idle suspend disabled by config');
  }

  // Reap the whole tree when the client that launched it is gone. stdin
  // end/close is supposed to catch that, but never fires when an `npm exec`
  // wrapper sits in between and outlives the client still holding our pipe -
  // which is how trees end up alive for days after their window closed.
  const clientWatcher = new ClientWatcher({
    pollIntervalMs: sessionConfig.clientPollSeconds * 1000,
    logStderr,
  });
  clientWatcher.start(process.pid, (client) => {
    void shutdown(`client PID ${client.pid} exited`);
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
    clientWatcher.stop();
    if (idleCheckTimer) clearInterval(idleCheckTimer);
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
