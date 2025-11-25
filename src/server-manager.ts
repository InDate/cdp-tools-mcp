/**
 * Server Manager
 * Manages development servers (any language/framework) - start, stop, restart, and monitor
 * Supports multiple runner types: native (spawn), docker, docker-compose
 * Persists state to .cdp-tools/servers.json for recovery and auto-run
 * Logs to .cdp-tools/logs/<server-id>/ for cross-MCP access (native runner only)
 */

import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';
import { debugLog } from './debug-logger.js';
import { getOutputPath } from './paths.js';
import {
  type Runner,
  type RunnerType,
  type PersistedRunnerState,
  detectRunnerType,
  createRunner,
  NativeRunner,
  DockerRunner,
  DockerComposeRunner,
} from './runners/index.js';

/**
 * Validate server ID to prevent security issues.
 * Server IDs are used in container names, file paths, and project names.
 * Only alphanumeric characters, dashes, and underscores are allowed.
 */
function validateServerId(id: string): void {
  if (!id || id.length === 0) {
    throw new Error('Server ID cannot be empty');
  }
  if (id.length > 64) {
    throw new Error('Server ID cannot exceed 64 characters');
  }
  // Only allow alphanumeric, dash, underscore
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(
      `Invalid server ID "${id}". Server IDs can only contain letters, numbers, dashes, and underscores.`
    );
  }
  // Cannot start with a dash (would cause issues with CLI args)
  if (id.startsWith('-')) {
    throw new Error('Server ID cannot start with a dash');
  }
}

export interface ServerStatus {
  id: string;
  command: string;
  cwd: string;
  pid: number;
  containerId?: string;
  startedAt: Date;
  uptime: string;
  port?: number;
  running: boolean;
  autoRun: boolean;
  runnerType: RunnerType;
}

export interface StartServerOptions {
  command: string;
  cwd: string;
  id: string;
  autoRun?: boolean;
  env?: Record<string, string>;
  port?: number;
  /** Runner type - auto-detected from command if not specified */
  runner?: RunnerType;
  /** Optional: if provided, auto-monitor the detected port at this level */
  monitoringLevel?: MonitoringLevel;
}

export interface LogStats {
  serverId: string;
  newStdout: number;
  newStderr: number;
}

interface ManagedServer {
  id: string;
  runner: Runner;
  autoRun: boolean;
  monitoringLevel?: MonitoringLevel;
}

// ============================================================================
// Port Monitoring Types and Class
// ============================================================================

export type MonitoringLevel = 'inform' | 'error' | 'block';

export interface PersistedMonitoredPort {
  port: number;
  level: MonitoringLevel;
  description?: string;
  interval?: number; // Custom interval in ms (overrides config)
}

export interface MonitoredPort {
  port: number;
  level: MonitoringLevel;
  description?: string;
  interval?: number; // Custom interval in ms (overrides config)
  status: 'up' | 'down' | 'connecting';
  socket: net.Socket | null;
  failedAt?: Date;
  acknowledged: boolean;
  reconnectTimer?: ReturnType<typeof setTimeout>;
}

export interface MonitoredPortStatus {
  port: number;
  level: MonitoringLevel;
  description?: string;
  interval?: number;
  status: 'up' | 'down' | 'connecting';
  failedAt?: Date;
  acknowledged: boolean;
}

export interface PortFailureInfo {
  port: number;
  level: MonitoringLevel;
  description?: string;
  failedAt: Date;
}

/** Function type for getting interval for a monitoring level */
export type GetIntervalForLevel = (level: MonitoringLevel) => number;

/**
 * Port Monitor - monitors ports using persistent TCP connections
 */
export class PortMonitor {
  private ports: Map<number, MonitoredPort> = new Map();
  private onFailureCallback?: (port: number, level: MonitoringLevel) => void;
  private getIntervalForLevel: GetIntervalForLevel;

  constructor(getIntervalForLevel?: GetIntervalForLevel) {
    // Default intervals if no config provided
    this.getIntervalForLevel = getIntervalForLevel ?? ((level) => {
      switch (level) {
        case 'block': return 1000;
        case 'error': return 2000;
        case 'inform': return 5000;
        default: return 2000;
      }
    });
  }

  onFailure(callback: (port: number, level: MonitoringLevel) => void): void {
    this.onFailureCallback = callback;
  }

  async startMonitoring(port: number, level: MonitoringLevel, description?: string, interval?: number): Promise<void> {
    const existing = this.ports.get(port);
    if (existing) {
      existing.level = level;
      existing.description = description;
      existing.interval = interval;
      if (existing.status === 'down' && existing.acknowledged) {
        existing.acknowledged = false;
      }
      await debugLog('PortMonitor', `Updated monitoring for port ${port}: level=${level}, interval=${interval ?? 'default'}`);
      return;
    }

    const monitored: MonitoredPort = {
      port,
      level,
      description,
      interval,
      status: 'connecting',
      socket: null,
      acknowledged: false,
    };

    this.ports.set(port, monitored);
    await debugLog('PortMonitor', `Starting monitoring for port ${port} (level: ${level}, interval: ${interval ?? 'default'})`);
    this.connectToPort(port);
  }

  private connectToPort(port: number): void {
    const monitored = this.ports.get(port);
    if (!monitored) return;

    if (monitored.reconnectTimer) {
      clearTimeout(monitored.reconnectTimer);
      monitored.reconnectTimer = undefined;
    }

    if (monitored.socket) {
      monitored.socket.removeAllListeners();
      monitored.socket.destroy();
      monitored.socket = null;
    }

    if (monitored.status !== 'up') {
      monitored.status = 'connecting';
    }

    const socket = new net.Socket();
    socket.setTimeout(5000);
    let hadError = false;

    socket.on('connect', async () => {
      const wasDown = monitored.status === 'down' || monitored.status === 'connecting';
      monitored.status = 'up';
      monitored.socket = socket;
      monitored.failedAt = undefined;
      monitored.acknowledged = false;
      if (wasDown) {
        await debugLog('PortMonitor', `Port ${port} is UP`);
      }
      socket.destroy();
    });

    socket.on('close', async () => {
      monitored.socket = null;
      if (!hadError) {
        this.scheduleReconnect(port);
      }
    });

    socket.on('error', async (err: NodeJS.ErrnoException) => {
      hadError = true;
      const wasUp = monitored.status === 'up';

      if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND') {
        if (wasUp || monitored.status === 'connecting') {
          monitored.status = 'down';
          monitored.failedAt = monitored.failedAt || new Date();
          monitored.socket = null;

          if (wasUp) {
            await debugLog('PortMonitor', `Port ${port} went DOWN: ${err.message}`);
            if (this.onFailureCallback) {
              this.onFailureCallback(port, monitored.level);
            }
          } else {
            await debugLog('PortMonitor', `Port ${port} is down: ${err.message}`);
          }
        }
      } else {
        await debugLog('PortMonitor', `Port ${port} connection error (ignoring): ${err.message}`);
      }

      this.scheduleReconnect(port);
    });

    socket.on('timeout', () => {
      hadError = true;
      socket.destroy();

      if (monitored.status === 'connecting' || monitored.status === 'up') {
        const wasUp = monitored.status === 'up';
        monitored.status = 'down';
        monitored.failedAt = monitored.failedAt || new Date();

        if (wasUp) {
          debugLog('PortMonitor', `Port ${port} went DOWN: connection timeout`);
          if (this.onFailureCallback) {
            this.onFailureCallback(port, monitored.level);
          }
        }
      }

      this.scheduleReconnect(port);
    });

    socket.connect(port, 'localhost');
  }

  private scheduleReconnect(port: number): void {
    const monitored = this.ports.get(port);
    if (!monitored || monitored.reconnectTimer) return;

    // Use per-port interval if set, otherwise get from config based on level
    const interval = monitored.interval ?? this.getIntervalForLevel(monitored.level);

    monitored.reconnectTimer = setTimeout(() => {
      monitored.reconnectTimer = undefined;
      if (this.ports.has(port)) {
        this.connectToPort(port);
      }
    }, interval);
  }

  async stopMonitoring(port: number): Promise<boolean> {
    const monitored = this.ports.get(port);
    if (!monitored) return false;

    if (monitored.socket) {
      monitored.socket.removeAllListeners();
      monitored.socket.destroy();
    }
    if (monitored.reconnectTimer) {
      clearTimeout(monitored.reconnectTimer);
    }

    this.ports.delete(port);
    await debugLog('PortMonitor', `Stopped monitoring port ${port}`);
    return true;
  }

  async acknowledgeFailure(port: number): Promise<boolean> {
    const monitored = this.ports.get(port);
    if (!monitored || monitored.status !== 'down') return false;

    monitored.acknowledged = true;
    await debugLog('PortMonitor', `Acknowledged failure for port ${port}`);
    return true;
  }

  getFailedPorts(): PortFailureInfo[] {
    const failed: PortFailureInfo[] = [];
    for (const [port, monitored] of this.ports) {
      if (monitored.status === 'down' && !monitored.acknowledged && monitored.failedAt) {
        failed.push({
          port,
          level: monitored.level,
          description: monitored.description,
          failedAt: monitored.failedAt,
        });
      }
    }
    return failed;
  }

  getFailedPortsByLevel(level: MonitoringLevel): PortFailureInfo[] {
    return this.getFailedPorts().filter(p => p.level === level);
  }

  hasBlockingFailures(): boolean {
    return this.getFailedPortsByLevel('block').length > 0;
  }

  getStatus(port?: number): MonitoredPortStatus[] {
    if (port !== undefined) {
      const monitored = this.ports.get(port);
      if (!monitored) return [];
      return [{
        port: monitored.port,
        level: monitored.level,
        description: monitored.description,
        interval: monitored.interval,
        status: monitored.status,
        failedAt: monitored.failedAt,
        acknowledged: monitored.acknowledged,
      }];
    }

    return Array.from(this.ports.values()).map(m => ({
      port: m.port,
      level: m.level,
      description: m.description,
      interval: m.interval,
      status: m.status,
      failedAt: m.failedAt,
      acknowledged: m.acknowledged,
    }));
  }

  getPersistedState(): PersistedMonitoredPort[] {
    return Array.from(this.ports.values()).map(m => ({
      port: m.port,
      level: m.level,
      description: m.description,
      interval: m.interval,
    }));
  }

  async restoreFromState(ports: PersistedMonitoredPort[]): Promise<void> {
    for (const p of ports) {
      await this.startMonitoring(p.port, p.level, p.description, p.interval);
    }
  }

  async stopAll(): Promise<void> {
    for (const port of this.ports.keys()) {
      await this.stopMonitoring(port);
    }
  }
}

// ============================================================================
// Server Manager
// ============================================================================

export class ServerManager {
  private servers: Map<string, ManagedServer> = new Map();
  private portMonitor: PortMonitor = new PortMonitor();

  getPortMonitor(): PortMonitor {
    return this.portMonitor;
  }

  private getServersFilePath(): string {
    return getOutputPath('servers.json');
  }

  /**
   * Initialize - load state and recover/start auto-run servers
   */
  async initialize(): Promise<{ recovered: string[]; started: string[]; failed: string[]; monitoredPorts: number[] }> {
    const recovered: string[] = [];
    const started: string[] = [];
    const failed: string[] = [];
    const monitoredPorts: number[] = [];

    const persisted = await this.loadState();

    // Restore monitored ports first
    if (persisted.monitoredPorts.length > 0) {
      await this.portMonitor.restoreFromState(persisted.monitoredPorts);
      monitoredPorts.push(...persisted.monitoredPorts.map(p => p.port));
      await debugLog('ServerManager', `Restored ${monitoredPorts.length} monitored ports`);
    }

    for (const server of persisted.servers) {
      const runnerType = server.type || 'native';
      const runner = createRunner(runnerType, server.id);

      // Restore runner state using the interface method (pass PersistedRunnerState directly)
      runner.restore(server);

      const isRunning = await runner.isRunning();

      if (isRunning) {
        this.servers.set(server.id, {
          id: server.id,
          runner,
          autoRun: server.autoRun,
          monitoringLevel: server.monitoringLevel,
        });

        // For native runner, init cursor to EOF (native-specific method)
        if (runner.type === 'native' && 'initializeCursorToEOF' in runner) {
          await (runner as any).initializeCursorToEOF();
        }

        recovered.push(server.id);
        await debugLog('ServerManager', `Recovered running server: ${server.id} (${runnerType})`);
      } else if (server.autoRun) {
        // Not running but autoRun - restart
        let success = false;
        const maxRetries = 3;

        for (let attempt = 1; attempt <= maxRetries && !success; attempt++) {
          try {
            if (server.port) {
              await this.waitForPortRelease(server.port, 5);
            }

            await this.startServer({
              command: server.command,
              cwd: server.cwd,
              id: server.id,
              autoRun: true,
              runner: runnerType,
              monitoringLevel: server.monitoringLevel,
            });
            started.push(server.id);
            success = true;
            await debugLog('ServerManager', `Auto-started server: ${server.id} (attempt ${attempt})`);
          } catch (err) {
            await debugLog('ServerManager', `Auto-start attempt ${attempt}/${maxRetries} failed for ${server.id}: ${err}`);
            if (attempt < maxRetries) {
              await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, attempt - 1)));
            }
          }
        }

        if (!success) {
          failed.push(server.id);
        }
      } else {
        // Not running and not autoRun - keep config for manual restart
        this.servers.set(server.id, {
          id: server.id,
          runner,
          autoRun: false,
          monitoringLevel: server.monitoringLevel,
        });
      }
    }

    await this.saveState();
    return { recovered, started, failed, monitoredPorts };
  }

  private async loadState(): Promise<{ servers: PersistedRunnerState[]; monitoredPorts: PersistedMonitoredPort[] }> {
    const filePath = this.getServersFilePath();

    try {
      if (fs.existsSync(filePath)) {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        const data = JSON.parse(content);

        // Handle migration from old format (no runner type)
        const servers = (data.servers || []).map((s: any) => ({
          ...s,
          type: s.type || 'native',
        }));

        return {
          servers,
          monitoredPorts: data.monitoredPorts || [],
        };
      }
    } catch (err) {
      await debugLog('ServerManager', `Failed to load state: ${err}`);
    }

    return { servers: [], monitoredPorts: [] };
  }

  async saveState(): Promise<void> {
    const dir = path.dirname(this.getServersFilePath());
    if (!fs.existsSync(dir)) {
      await fs.promises.mkdir(dir, { recursive: true });
    }

    const servers: PersistedRunnerState[] = [];

    for (const [id, managed] of this.servers) {
      const runner = managed.runner;
      const status = await runner.getStatus();

      let containerId: string | undefined;
      if (runner instanceof DockerRunner) {
        containerId = runner.getContainerId() ?? undefined;
      }

      servers.push({
        type: runner.type,
        id,
        command: this.getRunnerCommand(runner),
        cwd: this.getRunnerCwd(runner),
        pid: status.pid,
        containerId,
        port: status.port,
        autoRun: managed.autoRun,
        startedAt: status.startedAt?.toISOString() ?? new Date().toISOString(),
        monitoringLevel: managed.monitoringLevel,
      });
    }

    const monitoredPorts = this.portMonitor.getPersistedState();

    const data = {
      version: 4,
      updatedAt: new Date().toISOString(),
      servers,
      monitoredPorts,
    };

    await fs.promises.writeFile(
      this.getServersFilePath(),
      JSON.stringify(data, null, 2),
      'utf-8'
    );
  }

  private getRunnerCommand(runner: Runner): string {
    if (runner instanceof NativeRunner) return runner.getCommand();
    if (runner instanceof DockerRunner) return runner.getCommand();
    if (runner instanceof DockerComposeRunner) return runner.getCommand();
    return '';
  }

  private getRunnerCwd(runner: Runner): string {
    if (runner instanceof NativeRunner) return runner.getCwd();
    if (runner instanceof DockerRunner) return runner.getCwd();
    if (runner instanceof DockerComposeRunner) return runner.getCwd();
    return '';
  }

  private async isPortInUse(port: number): Promise<boolean> {
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
   * Start a server
   */
  async startServer(options: StartServerOptions): Promise<{ id: string; pid: number; runnerType: RunnerType; containerId?: string }> {
    const { command, cwd, id: serverId, autoRun, env, port, monitoringLevel } = options;

    // Validate server ID for security (prevents command injection via container names)
    validateServerId(serverId);

    // Auto-detect runner type if not specified
    const runnerType = options.runner ?? detectRunnerType(command);

    // Validate cwd exists
    if (!fs.existsSync(cwd)) {
      throw new Error(`Working directory does not exist: ${cwd}`);
    }

    // Check if already running
    const existing = this.servers.get(serverId);
    if (existing) {
      const isRunning = await existing.runner.isRunning();
      if (isRunning) {
        throw new Error(`Server "${serverId}" is already running. Stop it first or use restart.`);
      }
      this.servers.delete(serverId);
    }

    // Check port availability
    const existingStatus = existing ? await existing.runner.getStatus() : null;
    const portToCheck = port || existingStatus?.port;
    if (portToCheck) {
      const inUse = await this.isPortInUse(portToCheck);
      if (inUse) {
        throw new Error(`Port ${portToCheck} is already in use.`);
      }
    }

    await debugLog('ServerManager', `Starting server: ${command} (runner: ${runnerType})`);

    // Create and start runner
    const runner = createRunner(runnerType, serverId);
    const result = await runner.start({ command, cwd, id: serverId, env, port });

    this.servers.set(serverId, {
      id: serverId,
      runner,
      autoRun: autoRun ?? false,
      monitoringLevel,
    });

    // Start port detection in background
    this.detectPortInBackground(serverId);

    await this.saveState();

    await debugLog('ServerManager', `Server started: ${serverId} (${runnerType}, PID: ${result.pid})`);

    return {
      id: serverId,
      pid: result.pid,
      runnerType,
      containerId: result.containerId,
    };
  }

  private async detectPortInBackground(serverId: string): Promise<void> {
    const managed = this.servers.get(serverId);
    if (!managed) return;

    // Check periodically for 30 seconds
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));

      const current = this.servers.get(serverId);
      if (!current) break;

      const status = await current.runner.getStatus();
      if (status.port) {
        // Port already detected, check if we need to start monitoring
        if (current.monitoringLevel) {
          await this.portMonitor.startMonitoring(
            status.port,
            current.monitoringLevel,
            `Server: ${serverId}`
          );
          await this.saveState();
          await debugLog('ServerManager', `Auto-started monitoring for port ${status.port}`);
        }
        break;
      }

      const port = await current.runner.detectPort();
      if (port) {
        await this.saveState();
        await debugLog('ServerManager', `Detected port ${port} for ${serverId}`);

        // Auto-start port monitoring if level was specified
        if (current.monitoringLevel) {
          await this.portMonitor.startMonitoring(
            port,
            current.monitoringLevel,
            `Server: ${serverId}`
          );
          await this.saveState();
          await debugLog('ServerManager', `Auto-started monitoring for port ${port}`);
        }
        break;
      }
    }
  }

  /**
   * Stop a server
   */
  async stopServer(serverId: string): Promise<void> {
    const managed = this.servers.get(serverId);
    if (!managed) {
      throw new Error(`Server "${serverId}" not found. Use list action to see servers.`);
    }

    const isRunning = await managed.runner.isRunning();
    if (!isRunning) {
      await this.saveState();
      return;
    }

    await debugLog('ServerManager', `Stopping server ${serverId}`);
    await managed.runner.stop();
    await this.saveState();
    await debugLog('ServerManager', `Server ${serverId} stopped`);
  }

  /**
   * Restart a server
   */
  async restartServer(serverId: string): Promise<{ id: string; pid: number; runnerType: RunnerType; containerId?: string }> {
    const managed = this.servers.get(serverId);
    if (!managed) {
      throw new Error(`Server "${serverId}" not found.`);
    }

    const status = await managed.runner.getStatus();
    const command = this.getRunnerCommand(managed.runner);
    const cwd = this.getRunnerCwd(managed.runner);
    const { autoRun, monitoringLevel } = managed;

    await this.stopServer(serverId);

    if (status.port) {
      const released = await this.waitForPortRelease(status.port);
      if (!released) {
        throw new Error(`Port ${status.port} is still in use after stopping server.`);
      }
    } else {
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    return await this.startServer({
      command,
      cwd,
      id: serverId,
      autoRun,
      runner: managed.runner.type,
      monitoringLevel,
    });
  }

  /**
   * Set autoRun flag
   */
  async setAutoRun(serverId: string, autoRun: boolean): Promise<void> {
    const managed = this.servers.get(serverId);
    if (!managed) {
      throw new Error(`Server "${serverId}" not found.`);
    }

    managed.autoRun = autoRun;
    await this.saveState();
    await debugLog('ServerManager', `Set autoRun=${autoRun} for ${serverId}`);
  }

  /**
   * Get status of servers
   */
  async getStatus(serverId?: string): Promise<ServerStatus[]> {
    const formatUptime = (startedAt: Date): string => {
      const seconds = Math.floor((Date.now() - startedAt.getTime()) / 1000);
      if (seconds < 60) return `${seconds}s`;
      if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      return `${hours}h ${minutes}m`;
    };

    const getServerStatus = async (managed: ManagedServer): Promise<ServerStatus> => {
      const status = await managed.runner.getStatus();
      return {
        id: managed.id,
        command: this.getRunnerCommand(managed.runner),
        cwd: this.getRunnerCwd(managed.runner),
        pid: status.pid,
        containerId: status.containerId,
        startedAt: status.startedAt ?? new Date(),
        uptime: status.startedAt ? formatUptime(status.startedAt) : '0s',
        port: status.port,
        running: status.running,
        autoRun: managed.autoRun,
        runnerType: managed.runner.type,
      };
    };

    if (serverId) {
      const managed = this.servers.get(serverId);
      if (!managed) return [];
      return [await getServerStatus(managed)];
    }

    const results: ServerStatus[] = [];
    for (const managed of this.servers.values()) {
      results.push(await getServerStatus(managed));
    }
    return results;
  }

  /**
   * Get log stats (for native runner only)
   */
  getLogStats(): LogStats[] {
    const stats: LogStats[] = [];

    for (const [serverId, managed] of this.servers) {
      if (managed.runner instanceof NativeRunner) {
        const runnerStats = managed.runner.getLogStats();
        stats.push({
          serverId,
          newStdout: runnerStats.newStdout,
          newStderr: runnerStats.newStderr,
        });
      } else {
        stats.push({
          serverId,
          newStdout: 0,
          newStderr: 0,
        });
      }
    }

    return stats;
  }

  /**
   * Get logs from a server
   */
  async getLogs(serverId: string, options: { type?: 'stdout' | 'stderr' | 'all'; lines?: number; delta?: boolean } = {}): Promise<string[]> {
    const managed = this.servers.get(serverId);
    if (!managed) {
      throw new Error(`Server "${serverId}" not found`);
    }

    const { type = 'all', lines } = options;
    return await managed.runner.getLogs({ type, lines });
  }

  /**
   * Clear logs (native runner only)
   */
  async clearLogs(serverId: string): Promise<{ logDir: string; stdoutPath: string; stderrPath: string }> {
    const managed = this.servers.get(serverId);
    if (!managed) {
      throw new Error(`Server "${serverId}" not found`);
    }

    if (managed.runner instanceof NativeRunner) {
      return await managed.runner.clearLogs();
    }

    throw new Error(`clearLogs is only supported for native runner, not ${managed.runner.type}`);
  }

  /**
   * Stop all servers
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
   * Remove a server from config
   */
  async removeServer(serverId: string): Promise<void> {
    const managed = this.servers.get(serverId);
    if (!managed) {
      throw new Error(`Server "${serverId}" not found.`);
    }

    const isRunning = await managed.runner.isRunning();
    if (isRunning) {
      await this.stopServer(serverId);
    }

    this.servers.delete(serverId);
    await this.saveState();
    await debugLog('ServerManager', `Server ${serverId} removed from config`);
  }

  /**
   * Get running server IDs
   */
  async getRunningServerIds(): Promise<string[]> {
    const running: string[] = [];
    for (const [id, managed] of this.servers) {
      if (await managed.runner.isRunning()) {
        running.push(id);
      }
    }
    return running;
  }

  /**
   * Cleanup dead servers
   */
  async cleanup(): Promise<number> {
    let cleaned = 0;

    for (const [id, managed] of this.servers) {
      const isRunning = await managed.runner.isRunning();
      if (!isRunning && !managed.autoRun) {
        this.servers.delete(id);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      await this.saveState();
    }
    return cleaned;
  }
}
