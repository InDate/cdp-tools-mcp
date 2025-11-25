/**
 * Native Runner
 * Runs processes directly using Node.js spawn (the original behavior)
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { debugLog } from '../debug-logger.js';
import { getOutputPath } from '../helpers/paths.js';
import type {
  Runner,
  RunnerType,
  RunnerStartOptions,
  RunnerStartResult,
  RunnerStopOptions,
  RunnerLogOptions,
  RunnerStatus,
  PersistedRunnerState,
} from './types.js';

export class NativeRunner implements Runner {
  readonly type: RunnerType = 'native';

  private id: string;
  private command: string = '';
  private cwd: string = '';
  private process: ChildProcess | null = null;
  private pid: number = -1;
  private port: number | null = null;
  private startedAt: Date | null = null;
  private logCursor = { stdout: 0, stderr: 0 };

  constructor(id: string) {
    this.id = id;
  }

  /**
   * Restore state from persisted data (for recovery)
   */
  restore(data: PersistedRunnerState): void {
    this.command = data.command;
    this.cwd = data.cwd;
    this.pid = data.pid;
    this.port = data.port ?? null;
    this.startedAt = new Date(data.startedAt);
    this.process = null; // Attached, not owned
  }

  private getLogDir(): string {
    return getOutputPath('logs', this.id);
  }

  private getStdoutLogPath(): string {
    return path.join(this.getLogDir(), 'stdout.log');
  }

  private getStderrLogPath(): string {
    return path.join(this.getLogDir(), 'stderr.log');
  }

  private async ensureLogDir(): Promise<void> {
    const dir = this.getLogDir();
    if (!fs.existsSync(dir)) {
      await fs.promises.mkdir(dir, { recursive: true });
    }
  }

  private isProcessRunning(pid: number): boolean {
    if (pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private detectPortFromLine(line: string): number | null {
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

  async start(options: RunnerStartOptions): Promise<RunnerStartResult> {
    const { command, cwd, env } = options;

    this.command = command;
    this.cwd = cwd;

    // Validate cwd exists
    if (!fs.existsSync(cwd)) {
      throw new Error(`Working directory does not exist: ${cwd}`);
    }

    await debugLog('NativeRunner', `Starting: ${command} in ${cwd}`);

    // Ensure log directory exists
    await this.ensureLogDir();

    // Open log files for writing
    const stdoutPath = this.getStdoutLogPath();
    const stderrPath = this.getStderrLogPath();

    // Add restart marker to logs
    const timestamp = new Date().toISOString();
    const marker = `\n--- Server ${this.id} started at ${timestamp} ---\n`;
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

    this.process = serverProcess;
    this.pid = pid;
    this.startedAt = new Date();
    this.logCursor = { stdout: 0, stderr: 0 };

    await debugLog('NativeRunner', `Started: ${this.id} (PID: ${pid})`);

    return { pid };
  }

  async stop(options?: RunnerStopOptions): Promise<void> {
    const timeout = options?.timeout ?? 3000;

    if (!this.isProcessRunning(this.pid)) {
      this.pid = -1;
      this.process = null;
      return;
    }

    await debugLog('NativeRunner', `Stopping ${this.id} (PID: ${this.pid})`);

    // Kill process group
    try {
      process.kill(-this.pid, 'SIGTERM');
      await debugLog('NativeRunner', `Sent SIGTERM to process group -${this.pid}`);
    } catch (err) {
      await debugLog('NativeRunner', `Process group kill failed, trying single process: ${err}`);
      try {
        process.kill(this.pid, 'SIGTERM');
      } catch {
        // Process may already be dead
      }
    }

    // Wait for exit or force kill
    await new Promise<void>((resolve) => {
      const checkDead = () => {
        if (!this.isProcessRunning(this.pid)) {
          resolve();
          return true;
        }
        return false;
      };

      if (checkDead()) return;

      const timeoutId = setTimeout(async () => {
        clearInterval(interval);
        if (this.isProcessRunning(this.pid)) {
          await debugLog('NativeRunner', `${this.id} didn't exit gracefully, sending SIGKILL`);
          try {
            process.kill(-this.pid, 'SIGKILL');
          } catch {
            try {
              process.kill(this.pid, 'SIGKILL');
            } catch {
              // Already dead
            }
          }
        }
        resolve();
      }, timeout);

      const interval = setInterval(() => {
        if (checkDead()) {
          clearTimeout(timeoutId);
          clearInterval(interval);
        }
      }, 100);
    });

    this.pid = -1;
    this.process = null;
    await debugLog('NativeRunner', `Stopped ${this.id}`);
  }

  async isRunning(): Promise<boolean> {
    return this.isProcessRunning(this.pid);
  }

  async getStatus(): Promise<RunnerStatus> {
    const running = this.isProcessRunning(this.pid);
    return {
      running,
      pid: this.pid,
      port: this.port ?? undefined,
      startedAt: this.startedAt ?? undefined,
    };
  }

  async getLogs(options?: RunnerLogOptions): Promise<string[]> {
    const { type = 'all', lines, since } = options ?? {};

    const readLogFile = (filePath: string, cursorPos: number): string[] => {
      try {
        if (!fs.existsSync(filePath)) return [];
        const content = fs.readFileSync(filePath, 'utf-8');
        const allLines = content.split('\n').filter(l => l.length > 0);

        if (lines !== undefined) {
          return allLines.slice(-lines);
        } else if (since !== undefined) {
          return allLines.slice(since);
        } else {
          // Delta mode - return lines since cursor
          return allLines.slice(cursorPos);
        }
      } catch {
        return [];
      }
    };

    let result: string[] = [];

    if (type === 'stdout' || type === 'all') {
      const stdoutLogs = readLogFile(this.getStdoutLogPath(), this.logCursor.stdout);
      result = result.concat(stdoutLogs.map(l => type === 'all' ? `[out] ${l}` : l));
    }

    if (type === 'stderr' || type === 'all') {
      const stderrLogs = readLogFile(this.getStderrLogPath(), this.logCursor.stderr);
      result = result.concat(stderrLogs.map(l => type === 'all' ? `[err] ${l}` : l));
    }

    // Update cursor if delta mode
    if (lines === undefined && since === undefined) {
      this.logCursor.stdout = this.countFileLines(this.getStdoutLogPath());
      this.logCursor.stderr = this.countFileLines(this.getStderrLogPath());
    }

    return result;
  }

  private countFileLines(filePath: string): number {
    try {
      if (!fs.existsSync(filePath)) return 0;
      const content = fs.readFileSync(filePath, 'utf-8');
      return content.split('\n').filter(l => l.length > 0).length;
    } catch {
      return 0;
    }
  }

  async detectPort(): Promise<number | null> {
    if (this.port) return this.port;

    // Check logs for port
    for (const logPath of [this.getStdoutLogPath(), this.getStderrLogPath()]) {
      try {
        if (fs.existsSync(logPath)) {
          const content = await fs.promises.readFile(logPath, 'utf-8');
          for (const line of content.split('\n')) {
            const port = this.detectPortFromLine(line);
            if (port) {
              this.port = port;
              return port;
            }
          }
        }
      } catch {
        // Ignore read errors
      }
    }

    return null;
  }

  async cleanup(): Promise<void> {
    // Nothing special to clean up for native runner
  }

  /**
   * Initialize cursor to end of file (for recovered servers)
   */
  async initializeCursorToEOF(): Promise<void> {
    this.logCursor.stdout = this.countFileLines(this.getStdoutLogPath());
    this.logCursor.stderr = this.countFileLines(this.getStderrLogPath());
  }

  /**
   * Clear log files
   */
  async clearLogs(): Promise<{ logDir: string; stdoutPath: string; stderrPath: string }> {
    const logDir = this.getLogDir();
    const stdoutPath = this.getStdoutLogPath();
    const stderrPath = this.getStderrLogPath();

    await fs.promises.writeFile(stdoutPath, '', 'utf-8');
    await fs.promises.writeFile(stderrPath, '', 'utf-8');

    this.logCursor = { stdout: 0, stderr: 0 };

    return { logDir, stdoutPath, stderrPath };
  }

  /**
   * Get log stats for status line
   */
  getLogStats(): { newStdout: number; newStderr: number } {
    const stdoutLines = this.countFileLines(this.getStdoutLogPath());
    const stderrLines = this.countFileLines(this.getStderrLogPath());

    return {
      newStdout: Math.max(0, stdoutLines - this.logCursor.stdout),
      newStderr: Math.max(0, stderrLines - this.logCursor.stderr),
    };
  }

  /** Getters for state persistence */
  getId(): string { return this.id; }
  getCommand(): string { return this.command; }
  getCwd(): string { return this.cwd; }
  getPid(): number { return this.pid; }
  getPort(): number | null { return this.port; }
  getStartedAt(): Date | null { return this.startedAt; }

  /** Setters for port (when detected externally) */
  setPort(port: number): void { this.port = port; }
}
