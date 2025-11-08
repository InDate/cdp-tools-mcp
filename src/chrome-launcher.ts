/**
 * Chrome Launcher
 * Utilities for launching Chrome with debugging enabled
 */

import { spawn, ChildProcess } from 'child_process';
import * as os from 'os';
import * as path from 'path';

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
   * Launch Chrome with debugging enabled
   */
  launch(port: number = 9222, url?: string): Promise<{ port: number; pid: number }> {
    return new Promise((resolve, reject) => {
      if (this.chromeProcess) {
        reject(new Error('Chrome is already running. Use killChrome() to close the existing instance, or use connectDebugger() to connect to it instead.'));
        return;
      }

      this.debugPort = port;
      const chromePath = this.getChromePath();
      const userDataDir = path.join(os.tmpdir(), `chrome-debug-profile-${Date.now()}`);

      const args = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDir}`,
        '--no-first-run',
        '--no-default-browser-check',
      ];

      if (url) {
        args.push(url);
      }

      try {
        this.chromeProcess = spawn(chromePath, args, {
          detached: true,
          stdio: 'ignore',
        });

        const pid = this.chromeProcess.pid;

        this.chromeProcess.on('error', (error) => {
          reject(new Error(`Failed to launch Chrome: ${error.message}`));
        });

        // Give Chrome a moment to start
        setTimeout(() => {
          resolve({ port, pid: pid || -1 });
        }, 2000);

        // Unref so the process doesn't keep Node.js alive
        this.chromeProcess.unref();
      } catch (error) {
        reject(new Error(`Failed to spawn Chrome: ${error}`));
      }
    });
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
   */
  kill(): void {
    if (this.chromeProcess && !this.chromeProcess.killed) {
      this.chromeProcess.kill();
      this.chromeProcess = null;
    }
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
