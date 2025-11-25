/**
 * Runner Types
 * Common interfaces and types for process runners (native, docker, docker-compose, etc.)
 */

export type RunnerType = 'native' | 'docker' | 'docker-compose';

export interface RunnerStartOptions {
  command: string;
  cwd: string;
  id: string;
  env?: Record<string, string>;
  port?: number;
}

export interface RunnerStartResult {
  /** Process ID (for native) or container ID (for docker) */
  pid: number;
  /** Container ID for docker runners */
  containerId?: string;
  /** Detected port, if any */
  port?: number;
}

export interface RunnerStopOptions {
  /** Timeout in ms before force kill */
  timeout?: number;
}

export interface RunnerLogOptions {
  type?: 'stdout' | 'stderr' | 'all';
  lines?: number;
  /** For native runner: return lines since cursor */
  since?: number;
  /** Follow mode (tail -f style) - not implemented yet */
  follow?: boolean;
}

export interface RunnerStatus {
  running: boolean;
  pid: number;
  containerId?: string;
  port?: number;
  startedAt?: Date;
  /** Additional status info from docker inspect, etc. */
  details?: Record<string, unknown>;
}

/**
 * Runner interface - abstraction over different process models
 */
export interface Runner {
  readonly type: RunnerType;

  /**
   * Start the process/container
   */
  start(options: RunnerStartOptions): Promise<RunnerStartResult>;

  /**
   * Stop the process/container
   */
  stop(options?: RunnerStopOptions): Promise<void>;

  /**
   * Check if process/container is running
   */
  isRunning(): Promise<boolean>;

  /**
   * Get current status
   */
  getStatus(): Promise<RunnerStatus>;

  /**
   * Get logs from the process/container
   */
  getLogs(options?: RunnerLogOptions): Promise<string[]>;

  /**
   * Detect port from logs or container inspection
   */
  detectPort(): Promise<number | null>;

  /**
   * Clean up resources (close file handles, etc.)
   */
  cleanup(): Promise<void>;

  /**
   * Restore state from persisted data (for recovery after MCP restart)
   */
  restore(data: PersistedRunnerState): void;

  /**
   * Get the command used to start this runner
   */
  getCommand(): string;

  /**
   * Get the working directory for this runner
   */
  getCwd(): string;

  /**
   * Clear logs (optional - only native runner supports this)
   */
  clearLogs?(): Promise<{ logDir: string; stdoutPath: string; stderrPath: string }>;
}

/**
 * Runner state that can be persisted and restored
 */
export interface PersistedRunnerState {
  type: RunnerType;
  id: string;
  command: string;
  cwd: string;
  pid: number;
  containerId?: string;
  port?: number;
  autoRun: boolean;
  startedAt: string;
  monitorPort?: boolean;
}

/**
 * Auto-detect runner type from command string
 */
export function detectRunnerType(command: string): RunnerType {
  const trimmed = command.trim().toLowerCase();

  // Docker Compose patterns
  if (
    trimmed.startsWith('docker-compose ') ||
    trimmed.startsWith('docker compose ') ||
    /^docker\s+compose\s+/.test(trimmed)
  ) {
    return 'docker-compose';
  }

  // Docker patterns
  if (
    trimmed.startsWith('docker run ') ||
    trimmed.startsWith('docker start ') ||
    /^docker\s+run\s+/.test(trimmed)
  ) {
    return 'docker';
  }

  // Default to native
  return 'native';
}
