/**
 * Chrome Launcher
 * Utilities for launching Chrome with debugging enabled
 */

import { spawn, ChildProcess } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { getErrorMessage } from './messages.js';
import type { PortReserver } from './port-reserver.js';
import { debugLog } from './debug-logger.js';

export class ChromeLauncher {
  private chromeProcess: ChildProcess | null = null;
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
          // Chrome is ready and inspectable
          await debugLog('ChromeLauncher', `Chrome ready on port ${port} after ${i + 1} attempts`);
          return;
        }
      } catch (error) {
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

    if (this.chromeProcess) {
      throw new Error(getErrorMessage('CHROME_ALREADY_RUNNING'));
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
      this.chromeProcess = spawn(chromePath, args, {
        stdio: 'ignore',
      });

      const pid = this.chromeProcess.pid;
      await debugLog('ChromeLauncher', `Chrome process spawned with PID ${pid}`);

      // Handle process errors and unexpected exits
      let processExited = false;
      const exitHandler = () => {
        processExited = true;
      };

      this.chromeProcess.once('exit', exitHandler);
      this.chromeProcess.once('error', exitHandler);

      // Wait for Chrome to actually start and bind to the port
      await debugLog('ChromeLauncher', `Waiting for Chrome to become ready on port ${port}...`);
      try {
        await this.waitForChromeReady(port);
      } catch (waitError) {
        await debugLog('ChromeLauncher', `waitForChromeReady failed: ${waitError}`);
        // Clean up if Chrome failed to start
        if (this.chromeProcess && !this.chromeProcess.killed) {
          this.chromeProcess.kill();
        }
        this.chromeProcess = null;
        throw waitError;
      }

      // Check if process exited during startup
      if (processExited) {
        this.chromeProcess = null;
        throw new Error('Chrome process exited unexpectedly during startup');
      }

      // Remove exit handler now that Chrome is confirmed running
      this.chromeProcess.removeListener('exit', exitHandler);
      this.chromeProcess.removeListener('error', exitHandler);

      await debugLog('ChromeLauncher', `Chrome successfully started on port ${port} with PID ${pid}`);
      return { port, pid: pid || -1 };
    } catch (error) {
      await debugLog('ChromeLauncher', `Failed to launch Chrome: ${error}`);
      throw new Error(`Failed to launch Chrome: ${error}`);
    }
  }

  /**
   * Check if Chrome is running
   */
  isRunning(): boolean {
    return this.chromeProcess !== null && !this.chromeProcess.killed;
  }

  /**
   * Get the debug port
   */
  getDebugPort(): number {
    return this.debugPort;
  }

  /**
   * Kill the Chrome process
   * First attempts graceful shutdown with SIGTERM, then force kills with SIGKILL if needed
   */
  async kill(): Promise<void> {
    if (!this.chromeProcess || this.chromeProcess.killed) {
      return;
    }

    const pid = this.chromeProcess.pid;
    if (!pid) {
      this.chromeProcess = null;
      return;
    }

    await debugLog('ChromeLauncher', `Killing Chrome process (PID: ${pid})`);

    // Try graceful shutdown first (SIGTERM)
    try {
      this.chromeProcess.kill('SIGTERM');
      await debugLog('ChromeLauncher', `Sent SIGTERM to Chrome (PID: ${pid})`);
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
          debugLog('ChromeLauncher', `Chrome didn't exit gracefully, sending SIGKILL (PID: ${pid})`);
          try {
            this.chromeProcess?.kill('SIGKILL');
            debugLog('ChromeLauncher', `Sent SIGKILL to Chrome (PID: ${pid})`);
          } catch (killError) {
            debugLog('ChromeLauncher', `Failed to send SIGKILL: ${killError}`);
          }
        } catch {
          // Process already dead (signal 0 threw error)
          debugLog('ChromeLauncher', `Chrome exited gracefully (PID: ${pid})`);
        }
        resolve();
      }, 500);

      // If process exits before timeout, clear the timeout
      this.chromeProcess?.once('exit', () => {
        clearTimeout(timeout);
        debugLog('ChromeLauncher', `Chrome process exited (PID: ${pid})`);
        resolve();
      });
    });

    this.chromeProcess = null;
    await debugLog('ChromeLauncher', `Chrome cleanup complete`);
  }

  /**
   * Reset the launcher state (useful if Chrome was closed externally)
   */
  reset(): void {
    this.chromeProcess = null;
  }

  /**
   * Get Chrome launcher status
   */
  getStatus(): { running: boolean; port: number; pid?: number } {
    return {
      running: this.isRunning(),
      port: this.debugPort,
      pid: this.chromeProcess?.pid,
    };
  }
}
