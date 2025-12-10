/**
 * Docker Compose Runner
 * Runs services using Docker Compose CLI
 */

import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { debugLog } from '../debug-logger.js';
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

/**
 * Check if Docker Compose is available on the system
 * @returns The compose command to use ('docker compose' or 'docker-compose')
 * @throws Error if Docker Compose is not installed or not running
 */
function ensureComposeAvailable(): 'docker compose' | 'docker-compose' {
  // Try docker compose first (newer, recommended)
  try {
    const result = spawnSync('docker', ['compose', 'version'], {
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (!result.error && result.status === 0) {
      return 'docker compose';
    }
    // Check if Docker daemon is not running
    const stderr = result.stderr?.toString() || '';
    if (stderr.includes('Cannot connect') || stderr.includes('Is the docker daemon running')) {
      // Reset cache so next attempt will check again
      composeCommand = null;
      throw new Error('Docker daemon is not running. Please start Docker and try again.');
    }
  } catch (err: any) {
    // Re-throw our own errors
    if (err.message?.includes('Docker daemon is not running')) {
      throw err;
    }
    // Fall through to try docker-compose
  }

  // Try docker-compose (older standalone)
  try {
    const result = spawnSync('docker-compose', ['version'], {
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (!result.error && result.status === 0) {
      return 'docker-compose';
    }
    // Check if Docker daemon is not running
    const stderr = result.stderr?.toString() || '';
    if (stderr.includes('Cannot connect') || stderr.includes('Is the docker daemon running')) {
      // Reset cache so next attempt will check again
      composeCommand = null;
      throw new Error('Docker daemon is not running. Please start Docker and try again.');
    }
  } catch (err: any) {
    // Re-throw our own errors
    if (err.message?.includes('Docker daemon is not running')) {
      throw err;
    }
    if (err.code === 'ENOENT') {
      throw new Error('Docker Compose is not installed. Please install Docker Desktop or docker-compose-plugin.');
    }
  }

  // Reset cache on failure
  composeCommand = null;
  throw new Error('Docker Compose is not available. Please install Docker Desktop (includes Compose) or the docker-compose-plugin.');
}

/**
 * Sanitize a string to be safe for use as a Docker project name.
 * Only allows alphanumeric characters, dashes, and underscores.
 */
function sanitizeForDocker(name: string): string {
  // Replace any character that isn't alphanumeric, dash, or underscore
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Cache for compose command - reset on failure */
let composeCommand: 'docker compose' | 'docker-compose' | null = null;

/**
 * Reset the Docker Compose availability cache.
 * Called before autoRun to ensure Docker is checked fresh.
 */
export function resetComposeCheck(): void {
  composeCommand = null;
}

export class DockerComposeRunner implements Runner {
  readonly type: RunnerType = 'docker-compose';

  private id: string;
  private command: string = '';
  private cwd: string = '';
  private projectName: string;
  private port: number | null = null;
  private startedAt: Date | null = null;
  private lastLogTimestamp: string | null = null;
  private composeFile: string | null = null;
  private env: Record<string, string> = {};

  constructor(id: string) {
    this.id = sanitizeForDocker(id);
    // Use sanitized server ID as project name for isolation
    this.projectName = `cdp-tools-${this.id}`;
  }

  /**
   * Restore state from persisted data
   */
  restore(data: PersistedRunnerState): void {
    this.command = data.command;
    this.cwd = data.cwd;
    this.port = data.port ?? null;
    this.startedAt = new Date(data.startedAt);
    this.detectComposeFile();
  }

  /**
   * Detect compose file from cwd
   */
  private detectComposeFile(): void {
    const possibleFiles = [
      'docker-compose.yml',
      'docker-compose.yaml',
      'compose.yml',
      'compose.yaml',
    ];

    for (const file of possibleFiles) {
      const filePath = path.join(this.cwd, file);
      if (fs.existsSync(filePath)) {
        this.composeFile = filePath;
        return;
      }
    }

    // Check if -f flag is in command
    const match = this.command.match(/-f\s+([^\s]+)/);
    if (match) {
      this.composeFile = path.resolve(this.cwd, match[1]);
    }
  }

  /**
   * Get the docker compose command and cache it
   * @returns The compose command to use
   */
  private getComposeCommand(): 'docker compose' | 'docker-compose' {
    if (composeCommand === null) {
      composeCommand = ensureComposeAvailable();
    }
    return composeCommand;
  }

  /**
   * Execute docker compose command using spawn with args array (prevents shell injection)
   */
  private execCompose(args: string[], extraEnv?: Record<string, string>): string {
    const cmd = this.getComposeCommand();
    const projectArgs = ['-p', this.projectName];

    // Add compose file if known
    if (this.composeFile) {
      projectArgs.push('-f', this.composeFile);
    }

    const fullArgs = [...projectArgs, ...args];

    // Determine command and arguments based on compose variant
    let spawnCmd: string;
    let spawnArgs: string[];

    if (cmd === 'docker compose') {
      spawnCmd = 'docker';
      spawnArgs = ['compose', ...fullArgs];
    } else {
      spawnCmd = 'docker-compose';
      spawnArgs = fullArgs;
    }

    const result = spawnSync(spawnCmd, spawnArgs, {
      cwd: this.cwd,
      encoding: 'utf-8',
      timeout: 120000, // 2 minutes for compose operations
      stdio: ['pipe', 'pipe', 'pipe'],
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });

    if (result.error) {
      throw new Error(result.error.message);
    }

    if (result.status !== 0) {
      const stderr = result.stderr?.toString() || '';
      const stdout = result.stdout?.toString() || '';
      const errorMsg = stderr || stdout || '';

      // Check if Docker daemon stopped while MCP was running
      if (errorMsg.includes('Cannot connect') || errorMsg.includes('Is the docker daemon running')) {
        // Reset cache so next attempt will re-check
        composeCommand = null;
        throw new Error('Docker daemon is not running. Please start Docker and try again.');
      }

      throw new Error(errorMsg || `Docker Compose command failed with status ${result.status}`);
    }

    return (result.stdout || '').trim();
  }

  /**
   * Parse the docker compose command to extract flags
   */
  private parseCommand(command: string): { services: string[]; detached: boolean; build: boolean } {
    const services: string[] = [];
    let detached = false;
    let build = false;

    // Check for -d/--detach
    detached = /\s-d(\s|$)/.test(command) || /\s--detach(\s|$)/.test(command);

    // Check for --build
    build = /\s--build(\s|$)/.test(command);

    // Extract service names (words after 'up' that aren't flags)
    const upMatch = command.match(/up\s+(.*)$/i);
    if (upMatch) {
      const afterUp = upMatch[1];
      const words = afterUp.split(/\s+/).filter(w => w && !w.startsWith('-'));
      services.push(...words);
    }

    return { services, detached, build };
  }

  async start(options: RunnerStartOptions): Promise<RunnerStartResult> {
    const { command, cwd, env } = options;

    this.command = command;
    this.cwd = cwd;
    this.env = env ?? {};
    this.detectComposeFile();

    await debugLog('DockerComposeRunner', `Starting: ${command} in ${cwd}`);

    const { services, build } = this.parseCommand(command);

    // Build compose up args
    const args = ['up', '-d']; // Always detached

    if (build) {
      args.push('--build');
    }

    // Add specific services if mentioned
    if (services.length > 0) {
      args.push(...services);
    }

    try {
      // Pass environment variables - Compose picks them up from the process environment
      // and they can be used in docker-compose.yml via ${VAR} syntax
      this.execCompose(args, this.env);
      this.startedAt = new Date();

      await debugLog('DockerComposeRunner', `Started compose project: ${this.projectName}`);

      // Try to detect port
      await this.detectPort();

      return {
        pid: -1,
        port: this.port ?? undefined,
      };
    } catch (err: any) {
      throw new Error(`Failed to start compose: ${err.message}`);
    }
  }

  async stop(options?: RunnerStopOptions): Promise<void> {
    const timeout = Math.floor((options?.timeout ?? 10000) / 1000);

    await debugLog('DockerComposeRunner', `Stopping compose project: ${this.projectName}`);

    try {
      // docker compose down stops and removes containers
      this.execCompose(['down', '-t', timeout.toString()]);
      await debugLog('DockerComposeRunner', `Stopped compose project: ${this.projectName}`);
    } catch (err) {
      await debugLog('DockerComposeRunner', `Stop failed: ${err}`);
      // Try force stop
      try {
        this.execCompose(['kill']);
        this.execCompose(['down']);
      } catch {
        // Ignore
      }
    }
  }

  async isRunning(): Promise<boolean> {
    try {
      const output = this.execCompose(['ps', '--format', 'json']);

      // Handle different output formats
      if (!output || output === '[]') {
        return false;
      }

      // Try to parse as JSON
      try {
        const parsed = JSON.parse(output);
        // Docker Compose may return a single object or an array
        const containers = Array.isArray(parsed) ? parsed : [parsed];
        return containers.length > 0 &&
          containers.some((c: any) => c.State === 'running' || c.Status?.includes('Up'));
      } catch {
        // Fallback: check for non-empty output with "running" or "Up"
        return output.includes('running') || output.includes('Up');
      }
    } catch {
      // If ps fails, project likely doesn't exist
      return false;
    }
  }

  async getStatus(): Promise<RunnerStatus> {
    const running = await this.isRunning();

    let details: Record<string, unknown> = {};

    if (running) {
      try {
        const output = this.execCompose(['ps', '--format', 'json']);
        const parsed = JSON.parse(output);
        const containers = Array.isArray(parsed) ? parsed : [parsed];
        details = {
          services: containers.map((c: any) => ({
            name: c.Service || c.Name,
            state: c.State || c.Status,
          })),
        };
      } catch {
        // Try table format fallback
        try {
          const output = this.execCompose(['ps']);
          details = { raw: output };
        } catch {
          // Ignore
        }
      }
    }

    return {
      running,
      pid: -1,
      port: this.port ?? undefined,
      startedAt: this.startedAt ?? undefined,
      details,
    };
  }

  async getLogs(options?: RunnerLogOptions): Promise<string[]> {
    // LIMITATION: Docker Compose 'logs' command returns logs from all services interleaved.
    // Like Docker, stdout and stderr are mixed together in chronological order.
    // The 'type' filter parameter is ignored for Compose - all logs are returned regardless.
    // This is a known Docker Compose CLI limitation.
    const { lines } = options ?? {};

    const args = ['logs'];

    // Add timestamps for tracking
    args.push('--timestamps');

    if (lines !== undefined) {
      args.push('--tail', lines.toString());
    } else if (this.lastLogTimestamp) {
      args.push('--since', this.lastLogTimestamp);
    } else {
      // Default to last 100 lines if no cursor
      args.push('--tail', '100');
    }

    try {
      const output = this.execCompose(args);
      const logLines = output.split('\n').filter(l => l.length > 0);

      // Update timestamp for delta mode
      if (lines === undefined && logLines.length > 0) {
        const lastLine = logLines[logLines.length - 1];
        // Compose log format: service_name | timestamp message
        const match = lastLine.match(/\|\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
        if (match) {
          this.lastLogTimestamp = match[1];
        }
      }

      return logLines;
    } catch {
      return [];
    }
  }

  async detectPort(): Promise<number | null> {
    if (this.port) return this.port;

    try {
      // Get port mappings from compose ps
      const output = this.execCompose(['ps', '--format', 'json']);
      const parsed = JSON.parse(output);
      const containers = Array.isArray(parsed) ? parsed : [parsed];

      for (const container of containers) {
        // Check Publishers array (newer format)
        if (container.Publishers) {
          for (const pub of container.Publishers) {
            if (pub.PublishedPort) {
              this.port = pub.PublishedPort;
              await debugLog('DockerComposeRunner', `Detected port ${this.port} for ${this.id}`);
              return this.port;
            }
          }
        }

        // Check Ports string (older format)
        if (container.Ports) {
          const match = container.Ports.match(/:(\d+)->/);
          if (match) {
            this.port = parseInt(match[1], 10);
            return this.port;
          }
        }
      }
    } catch {
      // Try alternative: parse compose file for exposed ports
      if (this.composeFile && fs.existsSync(this.composeFile)) {
        try {
          const content = fs.readFileSync(this.composeFile, 'utf-8');
          // Simple port pattern matching
          const match = content.match(/ports:\s*\n\s*-\s*["']?(\d+):/m);
          if (match) {
            this.port = parseInt(match[1], 10);
            return this.port;
          }
        } catch {
          // Ignore
        }
      }
    }

    return null;
  }

  async cleanup(): Promise<void> {
    // Nothing special to clean up
  }

  /** Getters for state persistence */
  getId(): string { return this.id; }
  getCommand(): string { return this.command; }
  getCwd(): string { return this.cwd; }
  getPid(): number { return -1; }
  getPort(): number | null { return this.port; }
  getStartedAt(): Date | null { return this.startedAt; }
  getProjectName(): string { return this.projectName; }

  /** Setters */
  setPort(port: number): void { this.port = port; }
}
