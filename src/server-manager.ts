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
import { getOutputPath } from './helpers/paths.js';
import { configManager } from './config.js';
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
  global: boolean;
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
  /** If true, auto-add detected port to monitoredPorts with default level 'block' */
  monitorPort?: boolean;
  /** If true, store server state in global ~/.cdp-tools/ instead of project directory */
  global?: boolean;
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
  monitorPort?: boolean;
  global?: boolean; // Whether this server is stored in global ~/.cdp-tools/
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

  isMonitoring(port: number): boolean {
    return this.ports.has(port);
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
  private portMonitor: PortMonitor | null = null;

  /**
   * Get the port monitor instance (lazy-initialized)
   * Must be called after configManager.load() for config values to be used
   */
  getPortMonitor(): PortMonitor {
    if (!this.portMonitor) {
      // Lazy init - ensures config is loaded before we read intervals
      this.portMonitor = new PortMonitor((level) => configManager.getIntervalForLevel(level));
    }
    return this.portMonitor;
  }

  private getServersFilePath(global?: boolean): string {
    return getOutputPath('servers.json', { global: global ?? false });
  }

  /**
   * Initialize - load state and recover/start auto-run servers
   * Loads from both local (project) and global (~/.cdp-tools/) storage
   */
  async initialize(): Promise<{ recovered: string[]; started: string[]; failed: string[]; monitoredPorts: number[] }> {
    const recovered: string[] = [];
    const started: string[] = [];
    const failed: string[] = [];
    const monitoredPorts: number[] = [];

    // Load from both local and global storage
    const localPersisted = await this.loadState(false);
    const globalPersisted = await this.loadState(true);

    // Combine servers from both sources (local servers marked with global=false, global with global=true)
    const allServers = [
      ...localPersisted.servers.map(s => ({ ...s, global: false })),
      ...globalPersisted.servers.map(s => ({ ...s, global: true })),
    ];

    // Restore monitored ports from local config
    if (localPersisted.monitoredPorts.length > 0) {
      await this.getPortMonitor().restoreFromState(localPersisted.monitoredPorts);
      monitoredPorts.push(...localPersisted.monitoredPorts.map(p => p.port));
      await debugLog('ServerManager', `Restored ${monitoredPorts.length} monitored ports`);
    }

    for (const server of allServers) {
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
          monitorPort: server.monitorPort,
          global: server.global,
        });

        // For native runner, init cursor to EOF (native-specific method)
        if (runner.type === 'native' && 'initializeCursorToEOF' in runner) {
          await (runner as any).initializeCursorToEOF();
        }

        recovered.push(server.id);
        await debugLog('ServerManager', `Recovered running server: ${server.id} (${runnerType}, global=${server.global})`);
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
              monitorPort: server.monitorPort,
              global: server.global,
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
          // Still add to map so it can be manually restarted
          this.servers.set(server.id, {
            id: server.id,
            runner,
            autoRun: server.autoRun,
            monitorPort: server.monitorPort,
            global: server.global,
          });
        }
      } else {
        // Not running and not autoRun - keep config for manual restart
        this.servers.set(server.id, {
          id: server.id,
          runner,
          autoRun: false,
          monitorPort: server.monitorPort,
          global: server.global,
        });
      }
    }

    await this.saveState();
    return { recovered, started, failed, monitoredPorts };
  }

  private async loadState(global?: boolean): Promise<{ servers: PersistedRunnerState[]; monitoredPorts: PersistedMonitoredPort[] }> {
    const filePath = this.getServersFilePath(global);

    try {
      if (fs.existsSync(filePath)) {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        const data = JSON.parse(content);

        // Handle migration from old format (no runner type)
        const servers = (data.servers || []).map((s: any) => ({
          ...s,
          type: s.type || 'native',
          global: global ?? false,
        }));

        return {
          servers,
          monitoredPorts: data.monitoredPorts || [],
        };
      }
    } catch (err) {
      await debugLog('ServerManager', `Failed to load state from ${filePath}: ${err}`);
    }

    return { servers: [], monitoredPorts: [] };
  }

  async saveState(): Promise<void> {
    // Split servers by global flag
    const localServers: PersistedRunnerState[] = [];
    const globalServers: PersistedRunnerState[] = [];

    for (const [id, managed] of this.servers) {
      const runner = managed.runner;
      const status = await runner.getStatus();

      let containerId: string | undefined;
      if (runner instanceof DockerRunner) {
        containerId = runner.getContainerId() ?? undefined;
      }

      const serverData: PersistedRunnerState = {
        type: runner.type,
        id,
        command: this.getRunnerCommand(runner),
        cwd: this.getRunnerCwd(runner),
        pid: status.pid,
        containerId,
        port: status.port,
        autoRun: managed.autoRun,
        startedAt: status.startedAt?.toISOString() ?? new Date().toISOString(),
        monitorPort: managed.monitorPort,
      };

      if (managed.global) {
        globalServers.push(serverData);
      } else {
        localServers.push(serverData);
      }
    }

    const monitoredPorts = this.getPortMonitor().getPersistedState();

    // Save local servers to project directory
    const localPath = this.getServersFilePath(false);
    const localDir = path.dirname(localPath);
    if (!fs.existsSync(localDir)) {
      await fs.promises.mkdir(localDir, { recursive: true });
    }
    await fs.promises.writeFile(
      localPath,
      JSON.stringify({
        version: 4,
        updatedAt: new Date().toISOString(),
        servers: localServers,
        monitoredPorts, // Port monitoring stays in local config
      }, null, 2),
      'utf-8'
    );

    // Save global servers to ~/.cdp-tools/
    const globalPath = this.getServersFilePath(true);
    const globalDir = path.dirname(globalPath);
    if (!fs.existsSync(globalDir)) {
      await fs.promises.mkdir(globalDir, { recursive: true });
    }
    await fs.promises.writeFile(
      globalPath,
      JSON.stringify({
        version: 4,
        updatedAt: new Date().toISOString(),
        servers: globalServers,
        monitoredPorts: [], // Global doesn't track port monitoring
      }, null, 2),
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

  /**
   * Find PIDs of processes listening on a port using lsof
   */
  private async findProcessesOnPort(port: number): Promise<number[]> {
    return new Promise((resolve) => {
      const { exec } = require('child_process');
      exec(`lsof -ti :${port}`, (error: any, stdout: string) => {
        if (error || !stdout.trim()) {
          resolve([]);
          return;
        }
        const pids = stdout.trim().split('\n').map(p => parseInt(p, 10)).filter(p => !isNaN(p) && p > 0);
        resolve(pids);
      });
    });
  }

  /**
   * Get the working directory of a process by PID
   */
  private async getProcessCwd(pid: number): Promise<string | null> {
    return new Promise((resolve) => {
      const { exec } = require('child_process');
      // Use lsof to get the cwd of the process (works on macOS and Linux)
      exec(`lsof -p ${pid} | grep cwd | awk '{print $NF}'`, (error: any, stdout: string) => {
        if (error || !stdout.trim()) {
          resolve(null);
          return;
        }
        resolve(stdout.trim());
      });
    });
  }

  /**
   * Kill orphan processes holding a port, but only if they're in the expected directory
   * Returns: { killed: PIDs killed, foreign: PIDs that are from a different directory }
   */
  private async killOrphanProcessesOnPort(port: number, expectedCwd: string, expectedPid?: number): Promise<{ killed: number[]; foreign: number[] }> {
    const pids = await this.findProcessesOnPort(port);
    const killed: number[] = [];
    const foreign: number[] = [];

    for (const pid of pids) {
      // Skip if this is the expected process
      if (expectedPid && pid === expectedPid) continue;

      // Check if process is running from the expected directory
      const processCwd = await this.getProcessCwd(pid);

      if (!processCwd || !processCwd.startsWith(expectedCwd)) {
        // Process is from a different directory - don't kill it
        await debugLog('ServerManager', `Process ${pid} on port ${port} is from different directory (${processCwd}), not killing`);
        foreign.push(pid);
        continue;
      }

      try {
        await debugLog('ServerManager', `Killing orphan process ${pid} on port ${port} (cwd: ${processCwd})`);
        process.kill(pid, 'SIGTERM');
        killed.push(pid);

        // Wait briefly then force kill if needed
        await new Promise(resolve => setTimeout(resolve, 500));
        try {
          process.kill(pid, 0); // Check if still alive
          process.kill(pid, 'SIGKILL');
          await debugLog('ServerManager', `Force killed orphan process ${pid}`);
        } catch {
          // Process already dead
        }
      } catch (err) {
        await debugLog('ServerManager', `Failed to kill process ${pid}: ${err}`);
      }
    }

    return { killed, foreign };
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
    const { command, cwd, id: serverId, autoRun, env, port, monitorPort, global: isGlobal } = options;

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

    await debugLog('ServerManager', `Starting server: ${command} (runner: ${runnerType}, global: ${isGlobal ?? false})`);

    // Create and start runner
    const runner = createRunner(runnerType, serverId);

    // Set global flag on native runner for log storage location
    if (runner instanceof NativeRunner) {
      runner.setGlobal(isGlobal ?? false);
    }

    const result = await runner.start({ command, cwd, id: serverId, env, port });

    this.servers.set(serverId, {
      id: serverId,
      runner,
      autoRun: autoRun ?? false,
      monitorPort,
      global: isGlobal ?? false,
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
        if (current.monitorPort && !this.getPortMonitor().isMonitoring(status.port)) {
          await this.getPortMonitor().startMonitoring(
            status.port,
            'block', // Default level
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

        // Auto-start port monitoring if monitorPort is true and not already monitored
        if (current.monitorPort && !this.getPortMonitor().isMonitoring(port)) {
          await this.getPortMonitor().startMonitoring(
            port,
            'block', // Default level
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
   * Reloads config from persisted state to pick up any manual edits (e.g., port changes)
   */
  async restartServer(serverId: string): Promise<{ id: string; pid: number; runnerType: RunnerType; containerId?: string }> {
    const managed = this.servers.get(serverId);
    if (!managed) {
      throw new Error(`Server "${serverId}" not found.`);
    }

    // Reload config from persisted state to pick up any manual edits
    const persistedConfig = await this.reloadServerConfig(serverId);

    // Use persisted config values if available, otherwise fall back to in-memory
    const command = persistedConfig?.command ?? this.getRunnerCommand(managed.runner);
    const cwd = persistedConfig?.cwd ?? this.getRunnerCwd(managed.runner);
    const port = persistedConfig?.port;
    const autoRun = persistedConfig?.autoRun ?? managed.autoRun;
    const monitorPort = persistedConfig?.monitorPort ?? managed.monitorPort;
    const runnerType = persistedConfig?.type ?? managed.runner.type;

    // Get current status for the old port (to clean up if different from new port)
    const currentStatus = await managed.runner.getStatus();
    const oldPort = currentStatus.port;

    await this.stopServer(serverId);

    // Wait for old port to be released (if server was running)
    if (oldPort) {
      let released = await this.waitForPortRelease(oldPort, 3);

      if (!released) {
        // Kill any orphan processes holding the port, but only if they're from the same directory
        const { killed, foreign } = await this.killOrphanProcessesOnPort(oldPort, cwd, currentStatus.pid);

        if (foreign.length > 0 && oldPort === port) {
          // Foreign process on the port we want to use - error
          throw new Error(`Port ${oldPort} is in use by another application (PID: ${foreign.join(', ')}). Stop that process first or use a different port.`);
        }

        if (killed.length > 0) {
          await debugLog('ServerManager', `Killed ${killed.length} orphan process(es) on port ${oldPort}: ${killed.join(', ')}`);
          released = await this.waitForPortRelease(oldPort, 5);
        }
      }

      // Only error if we couldn't release the port AND it's the same port we want to use
      if (!released && oldPort === port) {
        throw new Error(`Port ${oldPort} is still in use after stopping server.`);
      }
    } else {
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Check if new port (from config) is available
    if (port && port !== oldPort) {
      const newPortInUse = await this.isPortInUse(port);
      if (newPortInUse) {
        const pids = await this.findProcessesOnPort(port);
        throw new Error(`Port ${port} is already in use (PID: ${pids.join(', ')}). Choose a different port.`);
      }
    }

    return await this.startServer({
      command,
      cwd,
      id: serverId,
      autoRun,
      runner: runnerType,
      monitorPort,
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
        global: managed.global ?? false,
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
   * Cleanup - refresh status of all servers (no longer removes stopped servers)
   * Stopped servers remain in config and can be manually restarted
   */
  async cleanup(): Promise<number> {
    // Just refresh status, don't remove anything
    // Servers are only removed via the explicit 'remove' action
    return 0;
  }

  /**
   * Reload a server's config from persisted state (for picking up manual edits)
   */
  private async reloadServerConfig(serverId: string): Promise<PersistedRunnerState | null> {
    const localPersisted = await this.loadState(false);
    const globalPersisted = await this.loadState(true);

    const allServers = [
      ...localPersisted.servers.map(s => ({ ...s, global: false })),
      ...globalPersisted.servers.map(s => ({ ...s, global: true })),
    ];

    return allServers.find(s => s.id === serverId) || null;
  }
}
