/**
 * Port Check Utility
 * Check if a port is open before attempting to connect
 */

import * as net from 'net';

export interface PortCheckResult {
  open: boolean;
  host: string;
  port: number;
  error?: string;
}

/**
 * Check if a port is open on a given host
 * @param port The port number to check
 * @param host The host to check (default: localhost)
 * @param timeoutMs Timeout in milliseconds (default: 2000)
 */
export async function checkPort(
  port: number,
  host: string = 'localhost',
  timeoutMs: number = 2000
): Promise<PortCheckResult> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
      }
    };

    socket.setTimeout(timeoutMs);

    socket.on('connect', () => {
      cleanup();
      resolve({ open: true, host, port });
    });

    socket.on('timeout', () => {
      cleanup();
      resolve({ open: false, host, port, error: 'Connection timed out' });
    });

    socket.on('error', (err: NodeJS.ErrnoException) => {
      cleanup();
      const errorMessage = err.code === 'ECONNREFUSED'
        ? 'Connection refused'
        : err.message;
      resolve({ open: false, host, port, error: errorMessage });
    });

    socket.connect(port, host);
  });
}

/**
 * Parse a URL and extract host and port
 * Returns null if URL is invalid or doesn't have a port
 */
export function parseUrlForPortCheck(url: string): { host: string; port: number } | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;

    // Get port from URL or use default based on protocol
    let port: number;
    if (parsed.port) {
      port = parseInt(parsed.port, 10);
    } else if (parsed.protocol === 'https:') {
      port = 443;
    } else if (parsed.protocol === 'http:') {
      port = 80;
    } else {
      return null;
    }

    return { host, port };
  } catch {
    return null;
  }
}

/**
 * Check if a URL's server is reachable
 * Only checks localhost/127.0.0.1 URLs (skips external URLs)
 */
export async function checkUrlPort(
  url: string,
  timeoutMs: number = 2000
): Promise<PortCheckResult | null> {
  const parsed = parseUrlForPortCheck(url);
  if (!parsed) {
    return null;
  }

  // Only check localhost URLs - external sites may have firewalls, CDNs, etc.
  const isLocalhost = parsed.host === 'localhost' ||
                      parsed.host === '127.0.0.1' ||
                      parsed.host === '0.0.0.0';

  if (!isLocalhost) {
    return null; // Skip check for non-localhost
  }

  return checkPort(parsed.port, parsed.host, timeoutMs);
}
