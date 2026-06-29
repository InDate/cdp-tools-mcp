/**
 * Chrome Launcher
 * Utilities for launching Chrome with debugging enabled
 */

import { spawn, ChildProcess } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import * as fs from 'fs';
import { getErrorMessage } from './messages.js';
import type { PortReserver } from './port-reserver.js';
import { debugLog } from './debug-logger.js';

export type ChromeCloseReason = 'inactivity' | 'manual' | 'crash' | 'external' | 'signal' | 'unknown';

export interface ChromeCloseEvent {
  port: number;
  pid: number;
  reason: ChromeCloseReason;
  timestamp: Date;
  exitCode?: number | null;
  signal?: string | null;
}

export type ChromeExitCallback = (event: ChromeCloseEvent) => void | Promise<void>;

export class ChromeLauncher {
  private chromeProcesses: Map<number, ChildProcess> = new Map();
  private launchLocks: Map<number, Promise<{ port: number; pid: number }>> = new Map();
  private lastCloseEvents: ChromeCloseEvent[] = [];
  private maxCloseEvents: number = 10; // Keep last 10 close events
  private pendingCloseReason: Map<number, ChromeCloseReason> = new Map(); // Track reason before kill
  private onExitCallback: ChromeExitCallback | null = null;

  /**
   * Set a callback to be invoked when any Chrome process exits.
   * Used for cleanup (closing stale connections) and port re-reservation.
   */
  setOnExitCallback(callback: ChromeExitCallback): void {
    this.onExitCallback = callback;
  }

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
   * Create Chrome preferences file that disables password manager popups
   * This is required because command-line flags alone don't reliably disable
   * the "Change your password" leak detection popup
   */
  private createChromePreferences(userDataDir: string): void {
    const defaultDir = path.join(userDataDir, 'Default');
    const prefsPath = path.join(defaultDir, 'Preferences');

    // Create Default directory if it doesn't exist
    if (!fs.existsSync(defaultDir)) {
      fs.mkdirSync(defaultDir, { recursive: true });
    }

    // Chrome preferences to disable password-related popups
    const preferences = {
      credentials_enable_service: false,
      profile: {
        password_manager_enabled: false,
        password_manager_leak_detection: false,
      },
      safebrowsing: {
        enabled: false,
        enhanced: false,
      },
      autofill: {
        profile_enabled: false,
        credit_card_enabled: false,
      },
    };

    fs.writeFileSync(prefsPath, JSON.stringify(preferences, null, 2));
    debugLog('ChromeLauncher', `Created Chrome preferences at ${prefsPath} with password manager disabled`);
  }

  /**
   * Check if a port is already in use using TCP connection
   */
  private async isPortInUse(port: number): Promise<boolean> {
    await debugLog('ChromeLauncher', `isPortInUse() checking port ${port}`);

    return new Promise((resolve) => {
      try {
        const socket = new net.Socket();

        socket.setTimeout(500);

        socket.on('connect', () => {
          socket.destroy();
          debugLog('ChromeLauncher', `isPortInUse() port ${port} is in use`).catch(() => {});
          resolve(true);
        });

        socket.on('timeout', () => {
          socket.destroy();
          debugLog('ChromeLauncher', `isPortInUse() timeout checking port ${port}, assuming free`).catch(() => {});
          resolve(false);
        });

        socket.on('error', (err: any) => {
          socket.destroy();
          if (err.code === 'ECONNREFUSED') {
            // Port is not in use
            debugLog('ChromeLauncher', `isPortInUse() port ${port} is free (ECONNREFUSED)`).catch(() => {});
            resolve(false);
          } else {
            // Other error, assume port is in use to be safe
            debugLog('ChromeLauncher', `isPortInUse() error checking port ${port}: ${err.code}, assuming in use`).catch(() => {});
            resolve(true);
          }
        });

        try {
          socket.connect(port, 'localhost');
        } catch (connectError) {
          debugLog('ChromeLauncher', `isPortInUse() socket.connect() threw for port ${port}: ${connectError}`).catch(() => {});
          socket.destroy();
          resolve(true); // Assume in use to be safe
        }
      } catch (error) {
        debugLog('ChromeLauncher', `isPortInUse() unexpected error for port ${port}: ${error}`).catch(() => {});
        resolve(true); // Assume in use to be safe
      }
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
  async launch(port: number = 9222, url?: string, portReserver?: PortReserver, headless: boolean = false, extraArgs: string[] = []): Promise<{ port: number; pid: number }> {
    await debugLog('ChromeLauncher', `launch() called with port ${port}, portReserver=${!!portReserver}, isReserved=${portReserver?.isReserved()}`);

    // CRITICAL: Check if another launch is in progress for this port
    // This prevents race conditions where two launch() calls happen simultaneously
    const existingLaunch = this.launchLocks.get(port);
    if (existingLaunch) {
      await debugLog('ChromeLauncher', `Another launch is in progress for port ${port}, waiting for it to complete...`);
      return existingLaunch; // Return the same promise, so both callers wait for the same launch
    }

    // Use isRunning() to verify the process is actually alive (handles external kills)
    if (this.isRunning(port)) {
      throw new Error(`Chrome is already running on port ${port}. Use killChrome() to stop it first, or specify a different port.`);
    }

    // Create a promise for this launch and store it in the lock map
    // This prevents concurrent launches on the same port
    const launchPromise = this.performLaunch(port, url, portReserver, headless, extraArgs);
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
  private async performLaunch(port: number, url?: string, portReserver?: PortReserver, headless: boolean = false, extraArgs: string[] = []): Promise<{ port: number; pid: number }> {
    await debugLog('ChromeLauncher', `performLaunch() starting for port ${port}`);

    // Check if port is in use by something OTHER than our port reserver
    // This prevents multiple Chrome instances from being launched on the same port
    let isPortInUse: boolean;
    try {
      isPortInUse = await this.isPortInUse(port);
      await debugLog('ChromeLauncher', `performLaunch() isPortInUse check completed: ${isPortInUse}`);
    } catch (portCheckError) {
      await debugLog('ChromeLauncher', `performLaunch() isPortInUse check failed: ${portCheckError}`);
      throw new Error(`Failed to check port availability: ${portCheckError}`);
    }
    const isOurReservation = portReserver && portReserver.isReserved() && portReserver.getPort() === port;

    if (isPortInUse && !isOurReservation) {
      // Port is in use by something else (not our reservation)
      throw new Error(`Port ${port} is already in use by another process or MCP instance. Please choose a different port.`);
    }

    if (!isPortInUse && !isOurReservation) {
      // Port is free but not reserved by us - this is fine, we can use it
      await debugLog('ChromeLauncher', `Port ${port} is free and not reserved, proceeding with launch`);
    }

    const chromePath = this.getChromePath();
    const userDataDir = path.join(os.tmpdir(), `chrome-debug-profile-${Date.now()}`);

    // Create Chrome preferences file to disable password manager popups
    // This is more reliable than command-line flags alone
    this.createChromePreferences(userDataDir);

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
      // Disable password manager and related popups that can block automation
      '--password-store=basic',
      '--use-mock-keychain',
      '--disable-save-password-bubble',
      '--disable-features=PasswordLeakDetection,PasswordCheck,PasswordImport,PasswordManagerOnboarding',
    ];

    // Add headless mode if requested (prevents focus stealing)
    if (headless) {
      args.push('--headless=new'); // Use new headless mode
    } else {
      args.push('--start-minimized'); // Launch minimized to reduce focus stealing
    }

    // Pass-through: any extra Chrome flags from the launchChrome call (extraArgs)
    // and/or the CDP_TOOLS_EXTRA_CHROME_ARGS env var (space-separated). Merged
    // after the managed defaults and before the URL (Chrome treats the trailing
    // positional arg as the page to open). Lets callers enable things like a fake
    // camera (--use-fake-device-for-media-stream) without patching this file.
    const envExtra = (process.env.CDP_TOOLS_EXTRA_CHROME_ARGS || '').split(/\s+/).filter(Boolean);
    const passthrough = [...extraArgs, ...envExtra];
    if (passthrough.length) {
      await debugLog('ChromeLauncher', `Passing through extra Chrome args: ${passthrough.join(' ')}`);
      args.push(...passthrough);
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

        // Record the close event with reason
        const pendingReason = this.pendingCloseReason.get(port);
        this.pendingCloseReason.delete(port);

        let reason: ChromeCloseReason;
        if (pendingReason) {
          reason = pendingReason;
        } else if (signal) {
          reason = 'signal';
        } else if (code !== 0 && code !== null) {
          reason = 'crash';
        } else {
          reason = 'external'; // Closed externally (user closed browser, etc.)
        }

        const closeEvent = this.recordCloseEvent(port, pid || -1, reason, code, signal);

        // Invoke the exit callback if set (for port re-reservation)
        if (this.onExitCallback) {
          debugLog('ChromeLauncher', `Invoking onExit callback for port ${port}`);
          // Don't await - fire and forget to avoid blocking exit handler
          Promise.resolve(this.onExitCallback(closeEvent)).catch((err) => {
            debugLog('ChromeLauncher', `onExit callback error: ${err}`);
          });
        }
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
   * Check if a process with the given PID is actually running
   * This handles the case where Chrome is killed externally (e.g., Activity Monitor, kill command)
   */
  private isProcessAlive(pid: number): boolean {
    try {
      // process.kill with signal 0 doesn't kill the process, just checks if it exists
      process.kill(pid, 0);
      return true;
    } catch {
      // ESRCH = No such process, EPERM = exists but no permission (still alive)
      return false;
    }
  }

  /**
   * Check if Chrome is running on a specific port, or if any Chrome instance is running
   * This verifies the process is actually alive, not just tracked
   */
  isRunning(port?: number): boolean {
    if (port !== undefined) {
      const chromeProcess = this.chromeProcesses.get(port);
      if (!chromeProcess || chromeProcess.killed) {
        return false;
      }
      // Verify the process is actually alive (handles external kills)
      const pid = chromeProcess.pid;
      if (!pid || !this.isProcessAlive(pid)) {
        // Process is dead but we didn't know - clean up tracking
        this.chromeProcesses.delete(port);
        this.recordCloseEvent(port, pid || -1, 'external', null, null);
        return false;
      }
      return true;
    }
    // Check if any Chrome instance is running - verify each one
    for (const [p, chromeProcess] of this.chromeProcesses.entries()) {
      const pid = chromeProcess.pid;
      if (pid && this.isProcessAlive(pid)) {
        return true;
      } else {
        // Clean up dead process
        this.chromeProcesses.delete(p);
        this.recordCloseEvent(p, pid || -1, 'external', null, null);
      }
    }
    return false;
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
   * Record a Chrome close event
   */
  private recordCloseEvent(port: number, pid: number, reason: ChromeCloseReason, exitCode?: number | null, signal?: string | null): ChromeCloseEvent {
    const event: ChromeCloseEvent = {
      port,
      pid,
      reason,
      timestamp: new Date(),
      exitCode,
      signal,
    };

    this.lastCloseEvents.push(event);

    // Keep only the last N events
    if (this.lastCloseEvents.length > this.maxCloseEvents) {
      this.lastCloseEvents.shift();
    }

    debugLog('ChromeLauncher', `Recorded close event: port=${port}, pid=${pid}, reason=${reason}, exitCode=${exitCode}, signal=${signal}`);
    return event;
  }

  /**
   * Get the last close events
   */
  getLastCloseEvents(): ChromeCloseEvent[] {
    return [...this.lastCloseEvents];
  }

  /**
   * Get Chrome launcher status for all instances
   * Verifies each process is actually alive and cleans up dead ones
   */
  getStatus(): { instances: Array<{ port: number; pid: number; running: boolean }>; lastCloseEvents: ChromeCloseEvent[] } {
    const instances: Array<{ port: number; pid: number; running: boolean }> = [];
    const deadPorts: number[] = [];

    for (const [port, chromeProcess] of this.chromeProcesses.entries()) {
      const pid = chromeProcess.pid || -1;
      const alive = pid > 0 && this.isProcessAlive(pid);

      if (!alive) {
        deadPorts.push(port);
      }

      instances.push({ port, pid, running: alive });
    }

    // Clean up dead processes
    for (const port of deadPorts) {
      const chromeProcess = this.chromeProcesses.get(port);
      const pid = chromeProcess?.pid || -1;
      this.chromeProcesses.delete(port);
      this.recordCloseEvent(port, pid, 'external', null, null);
    }

    // Return only alive instances
    return {
      instances: instances.filter(i => i.running),
      lastCloseEvents: this.lastCloseEvents
    };
  }

  /**
   * Set the pending close reason for a port (call before killing)
   */
  setPendingCloseReason(port: number, reason: ChromeCloseReason): void {
    this.pendingCloseReason.set(port, reason);
  }
}
