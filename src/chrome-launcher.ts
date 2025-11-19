/**
 * Chrome Launcher
 * Utilities for launching Chrome with debugging enabled
 */

import { spawn, ChildProcess } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { getErrorMessage } from './messages.js';
import type { PortReserver } from './port-reserver.js';
import { debugLog } from './debug-logger.js';

export class ChromeLauncher {
  private chromeProcesses: Map<number, ChildProcess> = new Map();
  private debugPort: number = 9222;

  /**
   * Get the Chrome executable path for the current platform
   */
  private getChromePath(): string {
    const platform = os.platform();

    switch (platform) {
      case 'darwin': // macOS
        return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      case 'win32': // Windows
        return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
      case 'linux':
        // Try common Linux paths
        return '/usr/bin/google-chrome';
      default:
        throw new Error(`Unsupported platform: ${platform}`);
    }
  }

  /**
   * Check if a port is already in use using TCP connection
   */
  private async isPortInUse(port: number): Promise<boolean> {
    await debugLog('ChromeLauncher', `isPortInUse() checking port ${port}`);

    return new Promise((resolve) => {
      const socket = new net.Socket();

      socket.setTimeout(500);

      socket.on('connect', () => {
        socket.destroy();
        debugLog('ChromeLauncher', `isPortInUse() port ${port} is in use`);
        resolve(true);
      });

      socket.on('timeout', () => {
        socket.destroy();
        debugLog('ChromeLauncher', `isPortInUse() timeout checking port ${port}, assuming free`);
        resolve(false);
      });

      socket.on('error', (err: any) => {
        socket.destroy();
        if (err.code === 'ECONNREFUSED') {
          // Port is not in use
          debugLog('ChromeLauncher', `isPortInUse() port ${port} is free (ECONNREFUSED)`);
          resolve(false);
        } else {
          // Other error, assume port is in use to be safe
          debugLog('ChromeLauncher', `isPortInUse() error checking port ${port}: ${err.code}, assuming in use`);
          resolve(true);
        }
      });

      socket.connect(port, 'localhost');
    });
  }

  /**
   * Wait for Chrome debugging port to become ready
   * Polls the /json/version endpoint until Chrome is inspectable
   */
  private async waitForChromeReady(port: number, maxAttempts: number = 15): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        // Use a race between fetch and timeout
        const fetchPromise = fetch(`http://localhost:${port}/json/version`);
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 1000)
        );

        const response = await Promise.race([fetchPromise, timeoutPromise]) as Response;

        if (response.ok) {
          // Validate it's actually Chrome responding, not the port reserver
          const text = await response.text();
          if (text.trim() === 'chrome-not-running') {
            await debugLog('ChromeLauncher', `Port ${port} is reserved by PortReserver, Chrome failed to bind`);
            throw new Error(`Port ${port} is reserved by another MCP instance. Chrome cannot bind to this port.`);
          }

          // Valid Chrome response
          await debugLog('ChromeLauncher', `Chrome ready on port ${port} after ${i + 1} attempts`);
          return;
        }
      } catch (error) {
        // Re-throw port reservation errors immediately
        if (error instanceof Error && error.message.includes('reserved by another MCP instance')) {
          throw error;
        }

        // Chrome not ready yet, continue polling
        // Only log every 5 attempts to reduce noise
        if (i % 5 === 0) {
          await debugLog('ChromeLauncher', `Waiting for Chrome on port ${port} (attempt ${i + 1}/${maxAttempts}) - error: ${error}`);
        }
      }

      // Exponential backoff: 500ms + (attempt * 200ms)
      await new Promise(resolve => setTimeout(resolve, 500 + i * 200));
    }

    throw new Error(`Chrome debugging port ${port} failed to become inspectable within timeout. Chrome may have crashed during startup.`);
  }

  /**
   * Launch Chrome with debugging enabled
   * Releases port reservation before launching so Chrome can bind to it
   * Waits for Chrome to actually bind to the port before resolving
   */
  async launch(port: number = 9222, url?: string, portReserver?: PortReserver, headless: boolean = false): Promise<{ port: number; pid: number }> {
    await debugLog('ChromeLauncher', `launch() called with port ${port}, portReserver=${!!portReserver}, isReserved=${portReserver?.isReserved()}`);

    if (this.chromeProcesses.has(port)) {
      throw new Error(`Chrome is already running on port ${port}. Use killChrome() to stop it first, or specify a different port.`);
    }

    // Check if port is available before attempting to launch
    const isPortInUse = await this.isPortInUse(port);
    if (isPortInUse) {
      throw new Error(`Port ${port} is already in use by another process or MCP instance. Please choose a different port.`);
    }

    // Release port reservation if provided, so Chrome can bind to it
    if (portReserver && portReserver.isReserved()) {
      await debugLog('ChromeLauncher', `Releasing port ${port} for Chrome to use`);
      await portReserver.release();
      await debugLog('ChromeLauncher', `Port ${port} released successfully`);
    } else {
      await debugLog('ChromeLauncher', `NOT releasing port - portReserver=${!!portReserver}, isReserved=${portReserver?.isReserved()}`);
    }

    this.debugPort = port;
    const chromePath = this.getChromePath();
    const userDataDir = path.join(os.tmpdir(), `chrome-debug-profile-${Date.now()}`);

    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-popup-blocking',
      '--disable-prompt-on-repost',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ];

    // Add headless mode if requested (prevents focus stealing)
    if (headless) {
      args.push('--headless=new'); // Use new headless mode
    } else {
      args.push('--start-minimized'); // Launch minimized to reduce focus stealing
    }

    if (url) {
      args.push(url);
    }

    try {
      await debugLog('ChromeLauncher', `Spawning Chrome process on port ${port}...`);
      const chromeProcess = spawn(chromePath, args, {
        stdio: 'ignore',
      });

      const pid = chromeProcess.pid;
      await debugLog('ChromeLauncher', `Chrome process spawned with PID ${pid}`);

      // Handle process errors and unexpected exits
      let processExited = false;
      const exitHandler = () => {
        processExited = true;
      };

      chromeProcess.once('exit', exitHandler);
      chromeProcess.once('error', exitHandler);

      // Wait for Chrome to actually start and bind to the port
      await debugLog('ChromeLauncher', `Waiting for Chrome to become ready on port ${port}...`);
      try {
        await this.waitForChromeReady(port);
      } catch (waitError) {
        await debugLog('ChromeLauncher', `waitForChromeReady failed: ${waitError}`);
        // Clean up if Chrome failed to start - use SIGKILL for immediate termination
        if (chromeProcess && !chromeProcess.killed && pid) {
          await debugLog('ChromeLauncher', `Force killing orphaned Chrome process (PID: ${pid})`);
          try {
            chromeProcess.kill('SIGKILL');
            // Wait a moment to ensure kill completes
            await new Promise(resolve => setTimeout(resolve, 100));
          } catch (killError) {
            await debugLog('ChromeLauncher', `Failed to kill orphaned process: ${killError}`);
          }
        }
        throw waitError;
      }

      // Check if process exited during startup
      if (processExited) {
        throw new Error('Chrome process exited unexpectedly during startup');
      }

      // Remove exit handler now that Chrome is confirmed running
      chromeProcess.removeListener('exit', exitHandler);
      chromeProcess.removeListener('error', exitHandler);

      // Store the process in our map
      this.chromeProcesses.set(port, chromeProcess);

      // Set up auto-cleanup when process exits
      chromeProcess.once('exit', () => {
        debugLog('ChromeLauncher', `Chrome process on port ${port} exited, removing from tracking`);
        this.chromeProcesses.delete(port);
      });

      await debugLog('ChromeLauncher', `Chrome successfully started on port ${port} with PID ${pid}`);
      return { port, pid: pid || -1 };
    } catch (error) {
      await debugLog('ChromeLauncher', `Failed to launch Chrome: ${error}`);
      throw new Error(`Failed to launch Chrome: ${error}`);
    }
  }

  /**
   * Check if Chrome is running on a specific port, or if any Chrome instance is running
   */
  isRunning(port?: number): boolean {
    if (port !== undefined) {
      const process = this.chromeProcesses.get(port);
      return process !== undefined && !process.killed;
    }
    // Check if any Chrome instance is running
    return this.chromeProcesses.size > 0;
  }

  /**
   * Get the debug port (returns the last launched port for backwards compatibility)
   */
  getDebugPort(): number {
    return this.debugPort;
  }

  /**
   * Get all running Chrome ports
   */
  getRunningPorts(): number[] {
    return Array.from(this.chromeProcesses.keys());
  }

  /**
   * Kill Chrome process(es)
   * If port is specified, kills only that instance. Otherwise kills all instances.
   * First attempts graceful shutdown with SIGTERM, then force kills with SIGKILL if needed
   */
  async kill(port?: number): Promise<void> {
    if (port !== undefined) {
      // Kill specific instance
      await this.killInstance(port);
    } else {
      // Kill all instances
      const ports = Array.from(this.chromeProcesses.keys());
      await debugLog('ChromeLauncher', `Killing all Chrome instances (${ports.length} total)`);
      for (const p of ports) {
        await this.killInstance(p);
      }
    }
  }

  /**
   * Kill a specific Chrome instance by port
   */
  private async killInstance(port: number): Promise<void> {
    const chromeProcess = this.chromeProcesses.get(port);
    if (!chromeProcess || chromeProcess.killed) {
      return;
    }

    const pid = chromeProcess.pid;
    if (!pid) {
      this.chromeProcesses.delete(port);
      return;
    }

    await debugLog('ChromeLauncher', `Killing Chrome process on port ${port} (PID: ${pid})`);

    // Try graceful shutdown first (SIGTERM)
    try {
      chromeProcess.kill('SIGTERM');
      await debugLog('ChromeLauncher', `Sent SIGTERM to Chrome on port ${port} (PID: ${pid})`);
    } catch (error) {
      await debugLog('ChromeLauncher', `Failed to send SIGTERM: ${error}`);
    }

    // Wait 500ms for graceful shutdown, then force kill if needed
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        try {
          // Check if process still exists using signal 0 (doesn't actually kill)
          process.kill(pid, 0);
          // Process still exists, force kill
          debugLog('ChromeLauncher', `Chrome on port ${port} didn't exit gracefully, sending SIGKILL (PID: ${pid})`);
          try {
            chromeProcess.kill('SIGKILL');
            debugLog('ChromeLauncher', `Sent SIGKILL to Chrome on port ${port} (PID: ${pid})`);
          } catch (killError) {
            debugLog('ChromeLauncher', `Failed to send SIGKILL: ${killError}`);
          }
        } catch {
          // Process already dead (signal 0 threw error)
          debugLog('ChromeLauncher', `Chrome on port ${port} exited gracefully (PID: ${pid})`);
        }
        resolve();
      }, 500);

      // If process exits before timeout, clear the timeout
      chromeProcess.once('exit', () => {
        clearTimeout(timeout);
        debugLog('ChromeLauncher', `Chrome process on port ${port} exited (PID: ${pid})`);
        resolve();
      });
    });

    this.chromeProcesses.delete(port);
    await debugLog('ChromeLauncher', `Chrome cleanup complete for port ${port}`);
  }

  /**
   * Reset the launcher state (useful if Chrome was closed externally)
   */
  reset(port?: number): void {
    if (port !== undefined) {
      this.chromeProcesses.delete(port);
    } else {
      this.chromeProcesses.clear();
    }
  }

  /**
   * Get Chrome launcher status for all instances
   */
  getStatus(): { instances: Array<{ port: number; pid: number; running: boolean }> } {
    const instances = Array.from(this.chromeProcesses.entries()).map(([port, process]) => ({
      port,
      pid: process.pid || -1,
      running: !process.killed,
    }));

    return { instances };
  }
}
