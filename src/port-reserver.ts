/**
 * Port Reserver
 * Holds a port by binding a TCP socket to prevent other programs from using it
 */

import { createServer, Server } from 'net';

export class PortReserver {
  private server: Server | null = null;
  private port: number | null = null;
  private isReserving = false;

  /**
   * Reserve a port by binding a TCP socket to it
   */
  async reserve(port: number): Promise<void> {
    // If already reserving this port, do nothing
    if (this.port === port && this.server) {
      console.error(`[PortReserver] Port ${port} already reserved`);
      return;
    }

    // Release any existing reservation
    if (this.server) {
      await this.release();
    }

    return new Promise((resolve, reject) => {
      this.isReserving = true;
      this.server = createServer();

      // Handle incoming connections - respond immediately to indicate port is reserved
      this.server.on('connection', (socket) => {
        // Send a clear signal that this port is reserved and Chrome is not running
        socket.write('chrome-not-running\r\n');
        socket.end();
      });

      this.server.on('error', (err: any) => {
        this.isReserving = false;
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Port ${port} is already in use`));
        } else {
          reject(new Error(`Failed to reserve port ${port}: ${err.message}`));
        }
      });

      // Bind to IPv4 localhost to match Chrome's behavior
      this.server.listen(port, '127.0.0.1', () => {
        this.port = port;
        this.isReserving = false;
        console.error(`[PortReserver] Successfully reserved port ${port}`);
        resolve();
      });
    });
  }

  /**
   * Release the reserved port
   */
  async release(): Promise<void> {
    if (!this.server) {
      return;
    }

    return new Promise((resolve) => {
      const portToRelease = this.port;
      this.server!.close(() => {
        console.error(`[PortReserver] Released port ${portToRelease}`);
        this.server = null;
        this.port = null;
        resolve();
      });
    });
  }

  /**
   * Check if a port is currently reserved
   */
  isReserved(): boolean {
    return this.server !== null && this.port !== null;
  }

  /**
   * Get the currently reserved port
   */
  getPort(): number | null {
    return this.port;
  }

  /**
   * Get the server instance (for testing)
   */
  getServer(): Server | null {
    return this.server;
  }
}
