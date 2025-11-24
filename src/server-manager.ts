/**
 * Server Manager
 * Manages development servers (any language/framework) - start, stop, restart, and monitor
 * Persists state to .cdp-tools/servers.json for recovery and auto-run
 * Logs to .cdp-tools/logs/<server-id>/ for cross-MCP access
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';
import { debugLog } from './debug-logger.js';
import { getOutputPath } from './paths.js';

export interface PersistedServer {
  id: string;
  command: string;
  cwd: string;
  pid: number;
  port?: number;
  autoRun: boolean;
  startedAt: string;
}

export interface RunningServer {
  id: string;
  command: string;
  cwd: string;
  process: ChildProcess | null; // null if attached to existing process
  pid: number;
  startedAt: Date;
  port?: number;
  autoRun: boolean;
}

export interface ServerStatus {
  id: string;
  command: string;
  cwd: string;
  pid: number;
  startedAt: Date;
  uptime: string;
  port?: number;
  running: boolean;
  autoRun: boolean;
}

export interface StartServerOptions {
  command: string;
  cwd: string;
  id: string;
  autoRun?: boolean;
  env?: Record<string, string>;
  port?: number; // Optional: if provided, check port availability before starting
}

export interface LogCursor {
  stdout: number;
  stderr: number;
}

export interface LogStats {
  serverId: string;
  newStdout: number;
  newStderr: number;
}

export class ServerManager {
  private servers: Map<string, RunningServer> = new Map();

  // Per-session cursor tracking for log deltas
  private sessionCursors: Map<string, LogCursor> = new Map();

  /**
   * Initialize the server manager - load state and recover/start auto-run servers
   */
  async initialize(): Promise<{ recovered: string[]; started: string[]; failed: string[] }> {
    const recovered: string[] = [];
    const started: string[] = [];
    const failed: string[] = [];

    const persisted = await this.loadState();

    for (const server of persisted) {
      const isRunning = this.isProcessRunning(server.pid);

      if (isRunning) {
        // Process is still running - attach to it (no ChildProcess, just track)
        this.servers.set(server.id, {
          id: server.id,
          command: server.command,
          cwd: server.cwd,
          process: null, // Attached, not owned
          pid: server.pid,
          startedAt: new Date(server.startedAt),
          port: server.port,
          autoRun: server.autoRun,
        });
        recovered.push(server.id);

        // Set cursor to EOF so we only see new logs from this session
        await this.initializeCursorToEOF(server.id);

        await debugLog('ServerManager', `Recovered running server: ${server.id} (PID: ${server.pid})`);
      } else if (server.autoRun) {
        // Process died but autoRun is true - restart it with retry
        let success = false;
        const maxRetries = 3;

        for (let attempt = 1; attempt <= maxRetries && !success; attempt++) {
          try {
            // Wait for port release if known
            if (server.port) {
              await this.waitForPortRelease(server.port, 5);
            }

            await this.startServer({
              command: server.command,
              cwd: server.cwd,
              id: server.id,
              autoRun: true,
            });
            started.push(server.id);
            success = true;
            await debugLog('ServerManager', `Auto-started server: ${server.id} (attempt ${attempt})`);
          } catch (err) {
            await debugLog('ServerManager', `Auto-start attempt ${attempt}/${maxRetries} failed for ${server.id}: ${err}`);
            if (attempt < maxRetries) {
              // Exponential backoff: 500ms, 1000ms, 2000ms
              await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, attempt - 1)));
            }
          }
        }

        if (!success) {
          failed.push(server.id);
        }
      } else {
        // Not running and not autoRun - load into memory as stopped (so it can be manually restarted)
        this.servers.set(server.id, {
          id: server.id,
          command: server.command,
          cwd: server.cwd,
          process: null,
          pid: -1,
          startedAt: new Date(server.startedAt),
          port: server.port,
          autoRun: server.autoRun,
        });
      }
    }

    // Save updated state
    await this.saveState();

    return { recovered, started, failed };
  }

  /**
   * Get path for servers.json
   */
  private getServersFilePath(): string {
    return getOutputPath('servers.json');
  }

  /**
   * Get log directory for a server
   */
  private getLogDir(serverId: string): string {
    return getOutputPath('logs', serverId);
  }

  /**
   * Get stdout log file path
   */
  private getStdoutLogPath(serverId: string): string {
    return path.join(this.getLogDir(serverId), 'stdout.log');
  }

  /**
   * Get stderr log file path
   */
  private getStderrLogPath(serverId: string): string {
    return path.join(this.getLogDir(serverId), 'stderr.log');
  }

  /**
   * Ensure log directory exists
   */
  private async ensureLogDir(serverId: string): Promise<void> {
    const dir = this.getLogDir(serverId);
    if (!fs.existsSync(dir)) {
      await fs.promises.mkdir(dir, { recursive: true });
    }
  }

  /**
   * Initialize cursor to end of file (for recovered servers)
   */
  private async initializeCursorToEOF(serverId: string): Promise<void> {
    const stdoutLines = await this.countFileLines(this.getStdoutLogPath(serverId));
    const stderrLines = await this.countFileLines(this.getStderrLogPath(serverId));
    this.sessionCursors.set(serverId, { stdout: stdoutLines, stderr: stderrLines });
  }

  /**
   * Count lines in a file
   */
  private async countFileLines(filePath: string): Promise<number> {
    try {
      if (!fs.existsSync(filePath)) return 0;
      const content = await fs.promises.readFile(filePath, 'utf-8');
      return content.split('\n').filter(l => l.length > 0).length;
    } catch {
      return 0;
    }
  }

  /**
   * Load persisted server state (from disk, for multi-MCP support)
   */
  private async loadState(): Promise<PersistedServer[]> {
    const filePath = this.getServersFilePath();

    try {
      if (fs.existsSync(filePath)) {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        const data = JSON.parse(content);
        return data.servers || [];
      }
    } catch (err) {
      await debugLog('ServerManager', `Failed to load state: ${err}`);
    }

    return [];
  }

  /**
   * Save server state to disk
   */
  private async saveState(): Promise<void> {
    const dir = path.dirname(this.getServersFilePath());
    if (!fs.existsSync(dir)) {
      await fs.promises.mkdir(dir, { recursive: true });
    }

    const servers: PersistedServer[] = Array.from(this.servers.values()).map(s => ({
      id: s.id,
      command: s.command,
      cwd: s.cwd,
      pid: s.pid,
      port: s.port,
      autoRun: s.autoRun,
      startedAt: s.startedAt.toISOString(),
    }));

    const data = {
      version: 2,
      updatedAt: new Date().toISOString(),
      servers,
    };

    await fs.promises.writeFile(
      this.getServersFilePath(),
      JSON.stringify(data, null, 2),
      'utf-8'
    );
  }

  /**
   * Check if a process is running by PID
   */
  private isProcessRunning(pid: number): boolean {
    if (pid <= 0) return false; // Invalid PID (stopped server uses -1)
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if a port is in use
   */
  private isPortInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(300);

      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });

      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });

      socket.on('error', () => {
        socket.destroy();
        resolve(false);
      });

      socket.connect(port, 'localhost');
    });
  }

  /**
   * Wait for a port to be released with exponential backoff
   */
  private async waitForPortRelease(port: number, maxAttempts: number = 10): Promise<boolean> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const inUse = await this.isPortInUse(port);
      if (!inUse) {
        await debugLog('ServerManager', `Port ${port} released after ${attempt + 1} attempts`);
        return true;
      }

      const delay = Math.min(100 * Math.pow(2, attempt), 3000);
      await debugLog('ServerManager', `Port ${port} still in use, waiting ${delay}ms (attempt ${attempt + 1}/${maxAttempts})`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    await debugLog('ServerManager', `Port ${port} still in use after ${maxAttempts} attempts`);
    return false;
  }

  /**
   * Detect port from log line - improved patterns
   */
  private detectPort(line: string): number | null {
    const patterns = [
      /(?:port|listening on|localhost:|127\.0\.0\.1:)\s*(\d{4,5})/i,
      /http:\/\/(?:localhost|127\.0\.0\.1):(\d{4,5})/i,
      /Local:\s*http:\/\/[^:]+:(\d{4,5})/i,
      /ready on\s+.*:(\d{4,5})/i,
      /->\s*http:\/\/[^:]+:(\d{4,5})/i,
      /server.*running.*:(\d{4,5})/i,
    ];

    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match) {
        return parseInt(match[1], 10);
      }
    }
    return null;
  }

  /**
   * Start a server with a command
   */
  async startServer(options: StartServerOptions): Promise<{ id: string; pid: number }> {
    const { command, cwd, id: serverId, autoRun, env, port } = options;

    // Validate cwd exists
    if (!fs.existsSync(cwd)) {
      throw new Error(`Working directory does not exist: ${cwd}`);
    }

    // Check if already running
    const existing = this.servers.get(serverId);
    if (existing) {
      const isRunning = existing.process ? !existing.process.killed : this.isProcessRunning(existing.pid);
      if (isRunning) {
        throw new Error(`Server "${serverId}" is already running (PID: ${existing.pid}). Stop it first or use restart.`);
      }
      this.servers.delete(serverId);
    }

    // Check port availability if specified or if we know the previous port
    const portToCheck = port || existing?.port;
    if (portToCheck) {
      const inUse = await this.isPortInUse(portToCheck);
      if (inUse) {
        throw new Error(`Port ${portToCheck} is already in use. Wait for it to be released or use a different port.`);
      }
    }

    await debugLog('ServerManager', `Starting server: ${command} in ${cwd}`);

    // Ensure log directory exists
    await this.ensureLogDir(serverId);

    // Open log files for writing
    const stdoutPath = this.getStdoutLogPath(serverId);
    const stderrPath = this.getStderrLogPath(serverId);

    // Add restart marker to logs (don't clear - only clearLogs should wipe)
    const timestamp = new Date().toISOString();
    const marker = `\n--- Server ${serverId} started at ${timestamp} ---\n`;
    await fs.promises.appendFile(stdoutPath, marker, 'utf-8');
    await fs.promises.appendFile(stderrPath, marker, 'utf-8');

    const stdoutFd = fs.openSync(stdoutPath, 'a');
    const stderrFd = fs.openSync(stderrPath, 'a');

    // Spawn with stdio redirected to files
    const serverProcess = spawn(command, [], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', stdoutFd, stderrFd],
      shell: true,
      detached: true,
    });

    // Close file descriptors in parent process
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);

    const pid = serverProcess.pid || -1;
    if (pid === -1) {
      throw new Error('Failed to spawn server process');
    }

    // Unref so parent can exit independently
    serverProcess.unref();

    const server: RunningServer = {
      id: serverId,
      command,
      cwd,
      process: serverProcess,
      pid,
      startedAt: new Date(),
      autoRun: autoRun ?? false,
    };

    this.servers.set(serverId, server);

    // Initialize cursor to 0 for new server
    this.sessionCursors.set(serverId, { stdout: 0, stderr: 0 });

    // Start port detection in background
    this.detectPortFromLogs(serverId);

    await this.saveState();

    await debugLog('ServerManager', `Server started: ${serverId} (PID: ${pid})`);
    return { id: serverId, pid };
  }

  /**
   * Detect port from log files (runs in background)
   */
  private async detectPortFromLogs(serverId: string): Promise<void> {
    const server = this.servers.get(serverId);
    if (!server) return;

    // Check logs periodically for first 30 seconds
    const maxChecks = 30;
    for (let i = 0; i < maxChecks; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));

      const currentServer = this.servers.get(serverId);
      if (!currentServer || currentServer.port) break;

      // Read both log files
      const stdoutPath = this.getStdoutLogPath(serverId);
      const stderrPath = this.getStderrLogPath(serverId);

      for (const logPath of [stdoutPath, stderrPath]) {
        try {
          if (fs.existsSync(logPath)) {
            const content = await fs.promises.readFile(logPath, 'utf-8');
            for (const line of content.split('\n')) {
              const port = this.detectPort(line);
              if (port) {
                currentServer.port = port;
                await this.saveState();
                await debugLog('ServerManager', `Detected port ${port} for ${serverId}`);
                return;
              }
            }
          }
        } catch {
          // Ignore read errors
        }
      }
    }
  }

  /**
   * Stop a running server
   */
  async stopServer(serverId: string): Promise<void> {
    const server = this.servers.get(serverId);
    if (!server) {
      throw new Error(`Server "${serverId}" not found. Use list action to see running servers.`);
    }

    const pid = server.pid;
    const isRunning = server.process ? !server.process.killed : this.isProcessRunning(pid);

    if (!isRunning) {
      this.servers.delete(serverId);
      this.sessionCursors.delete(serverId);
      await this.saveState();
      return;
    }

    await debugLog('ServerManager', `Stopping server ${serverId} (PID: ${pid})`);

    // Kill process group
    try {
      process.kill(-pid, 'SIGTERM');
      await debugLog('ServerManager', `Sent SIGTERM to process group -${pid}`);
    } catch (err) {
      await debugLog('ServerManager', `Process group kill failed, trying single process: ${err}`);
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Process may already be dead
      }
    }

    // Wait for exit or force kill
    await new Promise<void>((resolve) => {
      const checkDead = () => {
        if (!this.isProcessRunning(pid)) {
          resolve();
          return true;
        }
        return false;
      };

      if (checkDead()) return;

      const timeout = setTimeout(async () => {
        clearInterval(interval);
        if (this.isProcessRunning(pid)) {
          await debugLog('ServerManager', `Server ${serverId} didn't exit gracefully, sending SIGKILL`);
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              // Already dead
            }
          }
        }
        resolve();
      }, 3000);

      const interval = setInterval(() => {
        if (checkDead()) {
          clearTimeout(timeout);
          clearInterval(interval);
        }
      }, 100);
    });

    // Keep the server config but mark it as stopped (process = null, pid = -1)
    server.process = null;
    server.pid = -1;
    this.sessionCursors.delete(serverId);
    await this.saveState();
    await debugLog('ServerManager', `Server ${serverId} stopped`);
  }

  /**
   * Restart a running server
   */
  async restartServer(serverId: string): Promise<{ id: string; pid: number }> {
    const server = this.servers.get(serverId);
    if (!server) {
      throw new Error(`Server "${serverId}" not found. Use list action to see running servers.`);
    }

    // Capture config before stopping (in case restart fails)
    const { command, cwd, port, autoRun } = server;

    await this.stopServer(serverId);

    if (port) {
      const released = await this.waitForPortRelease(port);
      if (!released) {
        // Re-add the server config so it's not lost
        if (autoRun) {
          this.servers.set(serverId, { ...server, process: null, pid: -1 });
          await this.saveState();
        }
        throw new Error(`Port ${port} is still in use after stopping server. Try again in a few seconds.`);
      }
    } else {
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    try {
      return await this.startServer({ command, cwd, id: serverId, autoRun });
    } catch (err) {
      // If restart fails and autoRun is true, preserve the config for later
      if (autoRun) {
        this.servers.set(serverId, { ...server, process: null, pid: -1 });
        await this.saveState();
      }
      throw err;
    }
  }

  /**
   * Set autoRun flag for a server
   */
  async setAutoRun(serverId: string, autoRun: boolean): Promise<void> {
    const server = this.servers.get(serverId);
    if (!server) {
      throw new Error(`Server "${serverId}" not found. Use list action to see running servers.`);
    }

    server.autoRun = autoRun;
    await this.saveState();
    await debugLog('ServerManager', `Set autoRun=${autoRun} for ${serverId}`);
  }

  /**
   * Get status of servers (merges in-memory with persisted for multi-MCP)
   */
  getStatus(serverId?: string): ServerStatus[] {
    const formatUptime = (startedAt: Date): string => {
      const seconds = Math.floor((Date.now() - startedAt.getTime()) / 1000);
      if (seconds < 60) return `${seconds}s`;
      if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      return `${hours}h ${minutes}m`;
    };

    const getServerStatus = (server: RunningServer): ServerStatus => {
      const isRunning = server.process ? !server.process.killed : this.isProcessRunning(server.pid);
      return {
        id: server.id,
        command: server.command,
        cwd: server.cwd,
        pid: server.pid,
        startedAt: server.startedAt,
        uptime: formatUptime(server.startedAt),
        port: server.port,
        running: isRunning,
        autoRun: server.autoRun,
      };
    };

    if (serverId) {
      const server = this.servers.get(serverId);
      if (!server) {
        return [];
      }
      return [getServerStatus(server)];
    }

    return Array.from(this.servers.values()).map(getServerStatus);
  }

  /**
   * Get log stats for all servers (for status line)
   */
  getLogStats(): LogStats[] {
    const stats: LogStats[] = [];

    for (const [serverId] of this.servers) {
      const cursor = this.sessionCursors.get(serverId) || { stdout: 0, stderr: 0 };

      const stdoutLines = this.countFileLinesSync(this.getStdoutLogPath(serverId));
      const stderrLines = this.countFileLinesSync(this.getStderrLogPath(serverId));

      stats.push({
        serverId,
        newStdout: Math.max(0, stdoutLines - cursor.stdout),
        newStderr: Math.max(0, stderrLines - cursor.stderr),
      });
    }

    return stats;
  }

  /**
   * Count lines synchronously (for status line)
   */
  private countFileLinesSync(filePath: string): number {
    try {
      if (!fs.existsSync(filePath)) return 0;
      const content = fs.readFileSync(filePath, 'utf-8');
      return content.split('\n').filter(l => l.length > 0).length;
    } catch {
      return 0;
    }
  }

  /**
   * Get logs from a server (delta mode by default)
   */
  getLogs(serverId: string, options: { type?: 'stdout' | 'stderr' | 'all'; lines?: number; delta?: boolean } = {}): string[] {
    const server = this.servers.get(serverId);
    if (!server) {
      throw new Error(`Server "${serverId}" not found`);
    }

    const { type = 'all', lines, delta = true } = options;
    const cursor = this.sessionCursors.get(serverId) || { stdout: 0, stderr: 0 };

    const readLogFile = (filePath: string, cursorPos: number): string[] => {
      try {
        if (!fs.existsSync(filePath)) return [];
        const content = fs.readFileSync(filePath, 'utf-8');
        const allLines = content.split('\n').filter(l => l.length > 0);

        if (lines !== undefined) {
          // Return last N lines (doesn't move cursor)
          return allLines.slice(-lines);
        } else if (delta) {
          // Return lines since cursor
          return allLines.slice(cursorPos);
        } else {
          return allLines;
        }
      } catch {
        return [];
      }
    };

    let result: string[] = [];

    if (type === 'stdout' || type === 'all') {
      const stdoutLogs = readLogFile(this.getStdoutLogPath(serverId), cursor.stdout);
      result = result.concat(stdoutLogs.map(l => type === 'all' ? `[out] ${l}` : l));
    }

    if (type === 'stderr' || type === 'all') {
      const stderrLogs = readLogFile(this.getStderrLogPath(serverId), cursor.stderr);
      result = result.concat(stderrLogs.map(l => type === 'all' ? `[err] ${l}` : l));
    }

    // Update cursor if delta mode and no specific line count requested
    if (delta && lines === undefined) {
      const newStdoutCount = this.countFileLinesSync(this.getStdoutLogPath(serverId));
      const newStderrCount = this.countFileLinesSync(this.getStderrLogPath(serverId));
      this.sessionCursors.set(serverId, { stdout: newStdoutCount, stderr: newStderrCount });
    }

    return result;
  }

  /**
   * Clear logs for a server (resets files and cursors)
   */
  async clearLogs(serverId: string): Promise<{ logDir: string; stdoutPath: string; stderrPath: string }> {
    const server = this.servers.get(serverId);
    if (!server) {
      throw new Error(`Server "${serverId}" not found`);
    }

    const logDir = this.getLogDir(serverId);
    const stdoutPath = this.getStdoutLogPath(serverId);
    const stderrPath = this.getStderrLogPath(serverId);

    // Clear log files
    await fs.promises.writeFile(stdoutPath, '', 'utf-8');
    await fs.promises.writeFile(stderrPath, '', 'utf-8');

    // Reset cursor to 0
    this.sessionCursors.set(serverId, { stdout: 0, stderr: 0 });

    return { logDir, stdoutPath, stderrPath };
  }

  /**
   * Stop all running servers
   */
  async stopAll(): Promise<string[]> {
    const stopped: string[] = [];
    for (const serverId of this.servers.keys()) {
      try {
        await this.stopServer(serverId);
        stopped.push(serverId);
      } catch (error) {
        await debugLog('ServerManager', `Failed to stop ${serverId}: ${error}`);
      }
    }
    return stopped;
  }

  /**
   * Remove a server from the config entirely (stops it first if running)
   */
  async removeServer(serverId: string): Promise<void> {
    const server = this.servers.get(serverId);
    if (!server) {
      throw new Error(`Server "${serverId}" not found. Use list action to see servers.`);
    }

    // Stop if running
    const isRunning = server.pid > 0 && (server.process ? !server.process.killed : this.isProcessRunning(server.pid));
    if (isRunning) {
      await this.stopServer(serverId);
    }

    // Now delete from map
    this.servers.delete(serverId);
    this.sessionCursors.delete(serverId);
    await this.saveState();
    await debugLog('ServerManager', `Server ${serverId} removed from config`);
  }

  /**
   * Get all running server IDs
   */
  getRunningServerIds(): string[] {
    return Array.from(this.servers.keys()).filter(id => {
      const server = this.servers.get(id);
      if (!server) return false;
      return server.process ? !server.process.killed : this.isProcessRunning(server.pid);
    });
  }

  /**
   * Clean up dead servers from the map (also removes stale entries)
   */
  async cleanup(): Promise<number> {
    let cleaned = 0;

    // Also load from disk to check for stale entries
    const persisted = await this.loadState();

    for (const [id, server] of this.servers.entries()) {
      const isRunning = server.process ? !server.process.killed : this.isProcessRunning(server.pid);
      if (!isRunning && !server.autoRun) {
        this.servers.delete(id);
        this.sessionCursors.delete(id);
        cleaned++;
      }
    }

    // Check persisted entries not in memory
    for (const ps of persisted) {
      if (!this.servers.has(ps.id)) {
        const isRunning = this.isProcessRunning(ps.pid);
        if (isRunning) {
          // Add to in-memory tracking
          this.servers.set(ps.id, {
            id: ps.id,
            command: ps.command,
            cwd: ps.cwd,
            process: null,
            pid: ps.pid,
            startedAt: new Date(ps.startedAt),
            port: ps.port,
            autoRun: ps.autoRun,
          });
          await this.initializeCursorToEOF(ps.id);
        }
      }
    }

    if (cleaned > 0) {
      await this.saveState();
    }
    return cleaned;
  }
}
