/**
 * Port Configuration
 * Shared module for debug port configuration to avoid circular dependencies
 */

// Default debug port (will be updated during initialization)
let debugPort = 9222;
let reservedPort = 9222;

/**
 * Get the current debug port
 */
export function getConfiguredDebugPort(): number {
  return debugPort;
}

/**
 * Get the reserved port (the one physically reserved by socket binding)
 */
export function getReservedPort(): number {
  return reservedPort;
}

/**
 * Set the debug port (called during initialization)
 */
export function setDebugPort(port: number): void {
  debugPort = port;
}

/**
 * Set the reserved port (called during initialization)
 */
export function setReservedPort(port: number): void {
  reservedPort = port;
}
