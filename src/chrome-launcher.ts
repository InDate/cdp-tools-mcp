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
  private launchLocks: Map<number, Promise<{ port: number; pid: number }>> = new Map();

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
   * Uses atomic release-and-launch to prevent race conditions
   * Waits for Chrome to actually bind to the port before resolving
   */
  async launch(port: number = 9222, url?: string, portReserver?: PortReserver, headless: boolean = false): Promise<{ port: number; pid: number }> {
    await debugLog('ChromeLauncher', `launch() called with port ${port}, portReserver=${!!portReserver}, isReserved=${portReserver?.isReserved()}`);

    // CRITICAL: Check if another launch is in progress for this port
    // This prevents race conditions where two launch() calls happen simultaneously
    const existingLaunch = this.launchLocks.get(port);
    if (existingLaunch) {
      await debugLog('ChromeLauncher', `Another launch is in progress for port ${port}, waiting for it to complete...`);
      return existingLaunch; // Return the same promise, so both callers wait for the same launch
    }

    if (this.chromeProcesses.has(port)) {
      throw new Error(`Chrome is already running on port ${port}. Use killChrome() to stop it first, or specify a different port.`);
    }

    // Create a promise for this launch and store it in the lock map
    // This prevents concurrent launches on the same port
    const launchPromise = this.performLaunch(port, url, portReserver, headless);
    this.launchLocks.set(port, launchPromise);

    try {
      const result = await launchPromise;
      return result;
    } finally {
      // Always clean up the lock when done (success or failure)
      this.launchLocks.delete(port);
    }
  }

  /**
   * Internal method that performs the actual Chrome launch
   * Separated from launch() to allow mutex/locking logic
   */
  private async performLaunch(port: number, url?: string, portReserver?: PortReserver, headless: boolean = false): Promise<{ port: number; pid: number }> {
    // Check if port is in use by something OTHER than our port reserver
    // This prevents multiple Chrome instances from being launched on the same port
    const isPortInUse = await this.isPortInUse(port);
    const isOurReservation = portReserver && portReserver.isReserved() && portReserver.getPort() === port;

    if (isPortInUse && !isOurReservation) {
      // Port is in use by something else (not our reservation)
      throw new Error(`Port ${port} is already in use by another process or MCP instance. Please choose a different port.`);
    }

    if (!isPortInUse && !isOurReservation) {
      // Port is free but not reserved by us - this is fine, we can use it
      await debugLog('ChromeLauncher', `Port ${port} is free and not reserved, proceeding with launch`);
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

    // Track whether we released the reservation (so we can re-reserve on failure)
    let didReleaseReservation = false;

    try {
      // ATOMIC OPERATION: Release port reservation immediately before spawning Chrome
      // This minimizes the race condition window to just a few milliseconds
      if (isOurReservation) {
        await debugLog('ChromeLauncher', `Releasing port reservation for ${port} immediately before spawn`);
        await portReserver.release();
        didReleaseReservation = true;
        await debugLog('ChromeLauncher', `Port ${port} released, spawning Chrome immediately...`);
      }

      await debugLog('ChromeLauncher', `Spawning Chrome process on port ${port}...`);
      const chromeProcess = spawn(chromePath, args, {
        stdio: 'ignore',
      });

      const pid = chromeProcess.pid;
      await debugLog('ChromeLauncher', `Chrome process spawned with PID ${pid}`);

      // CRITICAL FIX: Add to tracking map IMMEDIATELY after spawn to prevent orphans
      // This ensures the process is tracked even if waitForChromeReady fails
      this.chromeProcesses.set(port, chromeProcess);
      await debugLog('ChromeLauncher', `Added Chrome process (PID: ${pid}) to tracking map for port ${port}`);

      // Set up auto-cleanup when process exits (BEFORE waitForChromeReady)
      // This ensures cleanup happens even if the launch fails later
      chromeProcess.once('exit', (code, signal) => {
        debugLog('ChromeLauncher', `Chrome process on port ${port} (PID: ${pid}) exited (code: ${code}, signal: ${signal}), removing from tracking`);
        this.chromeProcesses.delete(port);
      });

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

        // Re-reserve the port if we released it (cleanup after failure)
        if (didReleaseReservation && portReserver) {
          try {
            await debugLog('ChromeLauncher', `Re-reserving port ${port} after Chrome launch failure`);
            await portReserver.reserve(port);
            await debugLog('ChromeLauncher', `Successfully re-reserved port ${port}`);
          } catch (reserveError) {
            await debugLog('ChromeLauncher', `Failed to re-reserve port ${port}: ${reserveError}`);
          }
        }

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
        // Remove from tracking map since we're about to throw
        // (exit handler will also remove it when process dies, but this is defensive)
        this.chromeProcesses.delete(port);
        throw waitError;
      }

      // Check if process exited during startup
      if (processExited) {
        // Remove from tracking since process is dead
        this.chromeProcesses.delete(port);
        throw new Error('Chrome process exited unexpectedly during startup');
      }

      // Remove temporary exit handler now that Chrome is confirmed running
      // (The permanent exit handler was already set up earlier)
      chromeProcess.removeListener('exit', exitHandler);
      chromeProcess.removeListener('error', exitHandler);

      await debugLog('ChromeLauncher', `Chrome successfully started on port ${port} with PID ${pid}`);
      return { port, pid: pid || -1 };
    } catch (error) {
      await debugLog('ChromeLauncher', `Failed to launch Chrome: ${error}`);

      // Re-reserve the port if we released it (cleanup after any failure)
      if (didReleaseReservation && portReserver) {
        try {
          await debugLog('ChromeLauncher', `Re-reserving port ${port} after outer catch block failure`);
          await portReserver.reserve(port);
          await debugLog('ChromeLauncher', `Successfully re-reserved port ${port}`);
        } catch (reserveError) {
          await debugLog('ChromeLauncher', `Failed to re-reserve port ${port}: ${reserveError}`);
        }
      }

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
