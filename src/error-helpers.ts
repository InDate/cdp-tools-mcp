/**
 * Error Helper Functions
 * Provides structured error responses with helpful suggestions
 */

import type { CDPManager } from './cdp-manager.js';
import type { PuppeteerManager } from './puppeteer-manager.js';

export interface StructuredError {
  success: false;
  error: string;
  code?: string;
  suggestions?: string[];
  example?: string;
}

/**
 * Check if browser automation is available and return error if not
 */
export function checkBrowserAutomation(
  cdpManager: CDPManager,
  puppeteerManager: PuppeteerManager,
  toolName: string
): StructuredError | null {
  if (!cdpManager.isConnected()) {
    return {
      success: false,
      error: 'Not connected to debugger',
      code: 'NOT_CONNECTED',
      suggestions: [
        'Connect to a debugger first using connectDebugger()',
        'For Chrome: connectDebugger({ port: 9222 })',
        'For Node.js: connectDebugger({ port: 9229 })',
      ],
      example: `connectDebugger({ port: 9222 })`,
    };
  }

  const runtimeType = cdpManager.getRuntimeType();

  if (runtimeType === 'node') {
    return {
      success: false,
      error: `Tool '${toolName}' requires browser automation, which is not available for Node.js debugging`,
      code: 'NODEJS_NOT_SUPPORTED',
      suggestions: [
        'This tool only works with Chrome/browser debugging',
        'For server-side debugging, use: setBreakpoint, getVariables, evaluateExpression',
        'To debug browser code, connect to Chrome on port 9222',
      ],
      example: 'connectDebugger({ port: 9222 })  // Connect to Chrome instead',
    };
  }

  if (!puppeteerManager.isConnected()) {
    return {
      success: false,
      error: 'Browser automation not available - Puppeteer not connected',
      code: 'PUPPETEER_NOT_CONNECTED',
      suggestions: [
        'Reconnect to the debugger',
        'This may happen if connection was partially established',
      ],
      example: 'disconnectDebugger() then connectDebugger({ port: 9222 })',
    };
  }

  return null;
}

/**
 * Format a structured error as MCP response
 */
export function formatErrorResponse(error: StructuredError) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(error, null, 2),
      },
    ],
    isError: true,
  };
}
