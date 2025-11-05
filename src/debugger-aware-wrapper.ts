/**
 * Debugger-Aware Action Wrapper
 * Wraps Puppeteer/CDP actions to detect and handle breakpoint pauses
 */

import type { CDPManager } from './cdp-manager.js';

export interface ActionResult<T = any> {
  success: boolean;
  pausedAtBreakpoint?: boolean;
  pauseInfo?: {
    url: string;
    lineNumber: number;
    columnNumber?: number;
    functionName: string;
    callStackDepth: number;
  };
  result?: T;
  error?: string;
}

/**
 * Execute an action with pause detection
 *
 * If the debugger is already paused, returns immediately with error.
 * Otherwise, races the action against pause detection.
 * If a breakpoint is hit during execution, returns pause info immediately.
 *
 * @param cdpManager - The CDP manager instance
 * @param action - The async action to execute
 * @param actionName - Name of the action (for error messages)
 * @param timeout - Timeout in ms (default: 30000)
 * @returns ActionResult with either success/result or pause info
 */
export async function executeWithPauseDetection<T = any>(
  cdpManager: CDPManager,
  action: () => Promise<T>,
  actionName: string,
  timeout: number = 30000
): Promise<ActionResult<T>> {
  // Pre-check: If already paused, return immediately
  if (cdpManager.isPaused()) {
    const pauseInfo = cdpManager.getPausedInfo();
    return {
      success: false,
      pausedAtBreakpoint: true,
      error: `Cannot perform ${actionName} while execution is paused at a breakpoint`,
      pauseInfo: pauseInfo.location ? {
        url: pauseInfo.location.url,
        lineNumber: pauseInfo.location.lineNumber,
        columnNumber: pauseInfo.location.columnNumber,
        functionName: pauseInfo.location.functionName,
        callStackDepth: pauseInfo.callStack?.length || 0,
      } : undefined,
    };
  }

  try {
    // Race the action against pause detection
    const result = await Promise.race([
      // The actual action
      action().then(res => ({ type: 'success' as const, result: res })),

      // Pause detection
      cdpManager.waitForPause(timeout).then(() => ({ type: 'paused' as const })),
    ]);

    if (result.type === 'paused') {
      // Breakpoint was hit during execution
      const pauseInfo = cdpManager.getPausedInfo();
      return {
        success: true,
        pausedAtBreakpoint: true,
        pauseInfo: pauseInfo.location ? {
          url: pauseInfo.location.url,
          lineNumber: pauseInfo.location.lineNumber,
          columnNumber: pauseInfo.location.columnNumber,
          functionName: pauseInfo.location.functionName,
          callStackDepth: pauseInfo.callStack?.length || 0,
        } : undefined,
      };
    } else {
      // Action completed successfully without hitting breakpoint
      return {
        success: true,
        pausedAtBreakpoint: false,
        result: result.result,
      };
    }
  } catch (error: any) {
    // Check if we're now paused (action might have failed due to pause)
    if (cdpManager.isPaused()) {
      const pauseInfo = cdpManager.getPausedInfo();
      return {
        success: true,
        pausedAtBreakpoint: true,
        pauseInfo: pauseInfo.location ? {
          url: pauseInfo.location.url,
          lineNumber: pauseInfo.location.lineNumber,
          columnNumber: pauseInfo.location.columnNumber,
          functionName: pauseInfo.location.functionName,
          callStackDepth: pauseInfo.callStack?.length || 0,
        } : undefined,
      };
    }

    // Real error (not pause-related)
    return {
      success: false,
      pausedAtBreakpoint: false,
      error: `${actionName} failed: ${error.message || error}`,
    };
  }
}

/**
 * Format action result for MCP tool response
 */
export function formatActionResult(result: ActionResult, actionName: string, details?: any): any {
  if (result.pausedAtBreakpoint && result.pauseInfo) {
    return {
      action: actionName,
      pausedAtBreakpoint: true,
      message: `Execution paused at breakpoint during ${actionName}`,
      location: {
        url: result.pauseInfo.url,
        line: result.pauseInfo.lineNumber,
        column: result.pauseInfo.columnNumber,
        function: result.pauseInfo.functionName,
      },
      callStackDepth: result.pauseInfo.callStackDepth,
      hint: 'Use getCallStack() to inspect, stepOver()/stepInto() to continue debugging, or resume() to continue execution',
      ...details,
    };
  }

  if (!result.success) {
    return {
      action: actionName,
      error: result.error,
      ...details,
    };
  }

  return {
    action: actionName,
    success: true,
    ...details,
    ...(result.result ? { result: result.result } : {}),
  };
}
