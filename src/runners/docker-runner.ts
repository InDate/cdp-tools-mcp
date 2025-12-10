/**
 * Docker Runner
 * Runs containers using Docker CLI
 */

import { spawnSync, execSync } from 'child_process';
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
 * Check if Docker is available on the system
 * @throws Error if Docker is not installed or not running
 */
function ensureDockerAvailable(): void {
  try {
    const result = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.error || result.status !== 0) {
      const stderr = result.stderr?.toString() || '';
      // Reset cache on any failure so we re-check next time
      dockerChecked = false;

      if (stderr.includes('Cannot connect') || stderr.includes('Is the docker daemon running')) {
        throw new Error('Docker daemon is not running. Please start Docker and try again.');
      }
      if (stderr.includes('paused') || stderr.includes('Paused')) {
        throw new Error('Docker Desktop is paused. Please unpause it and try again.');
      }
      // Pass through Docker's error message if available, otherwise generic message
      if (stderr.trim()) {
        throw new Error(stderr.trim());
      }
      throw new Error('Docker is not available. Please install Docker and try again.');
    }
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      throw new Error('Docker is not installed. Please install Docker from https://docs.docker.com/get-docker/');
    }
    // Reset cache on any error so we re-check next time
    dockerChecked = false;
    throw err;
  }
}

/** Cache for Docker availability check - reset on failure */
let dockerChecked = false;

/**
 * Reset the Docker availability cache.
 * Called before autoRun to ensure Docker is checked fresh.
 */
export function resetDockerCheck(): void {
  dockerChecked = false;
}

/**
 * Sanitize a string to be safe for use as a Docker container/project name.
 * Only allows alphanumeric characters, dashes, and underscores.
 */
function sanitizeForDocker(name: string): string {
  // Replace any character that isn't alphanumeric, dash, or underscore
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export class DockerRunner implements Runner {
  readonly type: RunnerType = 'docker';

  private id: string;
  private command: string = '';
  private cwd: string = '';
  private containerId: string | null = null;
  private containerName: string | null = null;
  private port: number | null = null;
  private startedAt: Date | null = null;
  private lastLogTimestamp: string | null = null;
  private env: Record<string, string> = {};

  constructor(id: string) {
    this.id = sanitizeForDocker(id);
    // Use sanitized server ID as container name for easy reference
    this.containerName = `cdp-tools-${this.id}`;
  }

  /**
   * Restore state from persisted data
   */
  restore(data: PersistedRunnerState): void {
    this.command = data.command;
    this.cwd = data.cwd;
    this.containerId = data.containerId ?? null;
    this.port = data.port ?? null;
    this.startedAt = new Date(data.startedAt);
  }

  /**
   * Execute docker command using spawn with args array (prevents shell injection)
   */
  private execDocker(args: string[], options?: { cwd?: string }): string {
    // Check Docker is available on first use
    if (!dockerChecked) {
      ensureDockerAvailable();
      dockerChecked = true;
    }

    const result = spawnSync('docker', args, {
      cwd: options?.cwd,
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
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
        dockerChecked = false;
        throw new Error('Docker daemon is not running. Please start Docker and try again.');
      }

      throw new Error(errorMsg || `Docker command failed with status ${result.status}`);
    }

    return (result.stdout || '').trim();
  }

  /**
   * Parse a docker run command string into an array of arguments.
   * This handles quoted strings properly.
   */
  private parseCommandArgs(command: string): string[] {
    const args: string[] = [];
    let current = '';
    let inQuote: string | null = null;
    let i = 0;

    // Skip 'docker run' prefix
    const runMatch = command.match(/^docker\s+run\s+/i);
    if (runMatch) {
      i = runMatch[0].length;
    }

    while (i < command.length) {
      const char = command[i];

      if (inQuote) {
        if (char === inQuote) {
          inQuote = null;
        } else {
          current += char;
        }
      } else if (char === '"' || char === "'") {
        inQuote = char;
      } else if (char === ' ' || char === '\t') {
        if (current) {
          args.push(current);
          current = '';
        }
      } else {
        current += char;
      }
      i++;
    }

    if (current) {
      args.push(current);
    }

    return args;
  }

  /**
   * Build docker run arguments from the command and options
   */
  private buildDockerRunArgs(command: string, envVars: Record<string, string>): string[] {
    const parsedArgs = this.parseCommandArgs(command);
    const args: string[] = ['run'];

    // Check if already has -d flag
    const hasDetached = parsedArgs.some(arg => arg === '-d' || arg === '--detach');
    const hasName = parsedArgs.some((arg, i) => arg === '--name' || (i > 0 && parsedArgs[i - 1] === '--name'));

    // Always run detached
    if (!hasDetached) {
      args.push('-d');
    }

    // Add container name if not present
    if (!hasName) {
      args.push('--name', this.containerName!);
    }

    // Add environment variables
    for (const [key, value] of Object.entries(envVars)) {
      args.push('-e', `${key}=${value}`);
    }

    // Add all parsed args
    args.push(...parsedArgs);

    return args;
  }

  async start(options: RunnerStartOptions): Promise<RunnerStartResult> {
    const { command, cwd, env } = options;

    // Check Docker is available
    if (!dockerChecked) {
      ensureDockerAvailable();
      dockerChecked = true;
    }

    this.command = command;
    this.cwd = cwd;
    this.env = env ?? {};

    await debugLog('DockerRunner', `Starting: ${command}`);

    // Remove any existing container with same name
    try {
      this.execDocker(['rm', '-f', this.containerName!]);
    } catch {
      // Container didn't exist, that's fine
    }

    // Build docker run arguments
    const dockerArgs = this.buildDockerRunArgs(command, this.env);

    await debugLog('DockerRunner', `Docker args: ${JSON.stringify(dockerArgs)}`);

    // Execute docker run with spawn (not shell) to prevent injection
    const result = spawnSync('docker', dockerArgs, {
      cwd,
      encoding: 'utf-8',
      timeout: 60000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (result.error) {
      throw new Error(`Failed to start container: ${result.error.message}`);
    }

    if (result.status !== 0) {
      const stderr = result.stderr?.toString() || '';
      const stdout = result.stdout?.toString() || '';
      throw new Error(`Failed to start container: ${stderr || stdout}`);
    }

    // Get short container ID (first 12 chars)
    const containerId = (result.stdout || '').trim();
    this.containerId = containerId.substring(0, 12);
    this.startedAt = new Date();

    await debugLog('DockerRunner', `Started container: ${this.containerId}`);

    // Try to detect port immediately
    await this.detectPort();

    return {
      pid: -1, // Docker doesn't use PIDs the same way
      containerId: this.containerId,
      port: this.port ?? undefined,
    };
  }

  async stop(options?: RunnerStopOptions): Promise<void> {
    const timeout = Math.floor((options?.timeout ?? 10000) / 1000); // Convert to seconds

    if (!this.containerId && !this.containerName) {
      return;
    }

    const target = this.containerId || this.containerName!;

    await debugLog('DockerRunner', `Stopping container: ${target}`);

    try {
      // Docker stop with timeout
      this.execDocker(['stop', '-t', timeout.toString(), target]);
      await debugLog('DockerRunner', `Stopped container: ${target}`);
    } catch (err) {
      await debugLog('DockerRunner', `Stop failed, trying kill: ${err}`);
      try {
        this.execDocker(['kill', target]);
      } catch {
        // Already dead
      }
    }

    // Remove the container
    try {
      this.execDocker(['rm', '-f', target]);
      await debugLog('DockerRunner', `Removed container: ${target}`);
    } catch {
      // Ignore removal errors
    }

    this.containerId = null;
  }

  async isRunning(): Promise<boolean> {
    if (!this.containerId && !this.containerName) {
      return false;
    }

    const target = this.containerId || this.containerName!;

    try {
      const output = this.execDocker(['inspect', '-f', '{{.State.Running}}', target]);
      return output === 'true';
    } catch {
      return false;
    }
  }

  async getStatus(): Promise<RunnerStatus> {
    const running = await this.isRunning();
    const target = this.containerId || this.containerName;

    let details: Record<string, unknown> = {};

    if (target && running) {
      try {
        const output = this.execDocker([
          'inspect',
          '-f',
          '{{.State.Status}}|{{.State.StartedAt}}|{{.RestartCount}}',
          target,
        ]);
        const [status, startedAt, restartCount] = output.split('|');
        details = { status, startedAt, restartCount: parseInt(restartCount, 10) };
      } catch {
        // Ignore
      }
    }

    return {
      running,
      pid: -1,
      containerId: this.containerId ?? undefined,
      port: this.port ?? undefined,
      startedAt: this.startedAt ?? undefined,
      details,
    };
  }

  async getLogs(options?: RunnerLogOptions): Promise<string[]> {
    const { type = 'all', lines } = options ?? {};

    if (!this.containerId && !this.containerName) {
      return [];
    }

    const target = this.containerId || this.containerName!;
    const args = ['logs'];

    // Add timestamps for delta tracking
    args.push('--timestamps');

    if (lines !== undefined) {
      args.push('--tail', lines.toString());
    } else if (this.lastLogTimestamp) {
      // Get logs since last check
      args.push('--since', this.lastLogTimestamp);
    }

    args.push(target);

    try {
      // LIMITATION: Docker CLI's 'logs' command returns both stdout and stderr interleaved
      // in chronological order. There's no reliable way to separate them without running
      // two separate processes or using the Docker API directly. The 'type' filter parameter
      // is ignored for Docker containers - all logs are returned regardless of type.
      // This is a known Docker CLI limitation.
      const output = this.execDocker(args);
      const logLines = output.split('\n').filter(l => l.length > 0);

      // Update timestamp for delta mode
      if (lines === undefined && logLines.length > 0) {
        // Extract timestamp from last line (format: 2024-01-01T12:00:00.000000000Z message)
        const lastLine = logLines[logLines.length - 1];
        const match = lastLine.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
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

    if (!this.containerId && !this.containerName) {
      return null;
    }

    const target = this.containerId || this.containerName!;

    try {
      // Get port mappings from container
      const output = this.execDocker(['port', target]);

      // Parse output like "8080/tcp -> 0.0.0.0:3000"
      for (const line of output.split('\n')) {
        const match = line.match(/-> (?:0\.0\.0\.0|127\.0\.0\.1|localhost):(\d+)/);
        if (match) {
          this.port = parseInt(match[1], 10);
          await debugLog('DockerRunner', `Detected port ${this.port} for ${this.id}`);
          return this.port;
        }
      }
    } catch {
      // No port mappings
    }

    // Also try docker inspect for exposed ports
    try {
      const output = this.execDocker([
        'inspect',
        '-f',
        '{{range $p, $conf := .NetworkSettings.Ports}}{{$p}}={{(index $conf 0).HostPort}} {{end}}',
        target,
      ]);

      const match = output.match(/=(\d+)/);
      if (match) {
        this.port = parseInt(match[1], 10);
        return this.port;
      }
    } catch {
      // Ignore
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
  getContainerId(): string | null { return this.containerId; }
  getPort(): number | null { return this.port; }
  getStartedAt(): Date | null { return this.startedAt; }

  /** Setters */
  setPort(port: number): void { this.port = port; }
}
