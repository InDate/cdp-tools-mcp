/**
 * Execution Control Tools
 */

import { z } from 'zod';
import { CDPManager } from '../cdp-manager.js';
import { createTool } from '../validation-helpers.js';
import { createSuccessResponse, createErrorResponse, formatCodeBlock } from '../messages.js';

// Schema with optional connectionReason
const executionSchema = z.object({
  connectionReason: z.string().optional().describe('Brief reason for needing this browser connection (3 descriptive words recommended). Requires existing tab or connection. Only needed for browser debugging, not Node.js.'),
}).strict();

export function createExecutionTools(
  cdpManager: CDPManager,
  resolveConnectionFromReason?: (connectionReason: string) => Promise<{
    connection: any;
    cdpManager: CDPManager;
    puppeteerManager: any;
    consoleMonitor: any;
    networkMonitor: any;
  } | null>
) {
  return {
    pause: createTool(
      'Pause execution of the debugged program',
      executionSchema,
      async (args) => {
        const { connectionReason } = args;

        // Resolve connection if connectionReason is provided
        let targetCdpManager = cdpManager;
        if (connectionReason && resolveConnectionFromReason) {
          const resolved = await resolveConnectionFromReason(connectionReason);
          if (!resolved) {
            return createErrorResponse('CONNECTION_NOT_FOUND');
          }
          targetCdpManager = resolved.cdpManager;
        }

        await targetCdpManager.pause();
        return createSuccessResponse('EXECUTION_PAUSED');
      }
    ),

    resume: createTool(
      'Resume execution of the debugged program',
      executionSchema,
      async (args) => {
        const { connectionReason } = args;

        // Resolve connection if connectionReason is provided
        let targetCdpManager = cdpManager;
        if (connectionReason && resolveConnectionFromReason) {
          const resolved = await resolveConnectionFromReason(connectionReason);
          if (!resolved) {
            return createErrorResponse('CONNECTION_NOT_FOUND');
          }
          targetCdpManager = resolved.cdpManager;
        }

        // Check if execution was paused due to logpoint limit exceeded
        const logpointLimit = targetCdpManager.getLogpointLimitExceeded();

        if (logpointLimit) {
          // Format logs as a code block
          const logsFormatted = formatCodeBlock(logpointLimit.logs);

          return createErrorResponse('LOGPOINT_LIMIT_EXCEEDED', {
            url: logpointLimit.url,
            lineNumber: logpointLimit.lineNumber,
            executionCount: logpointLimit.executionCount,
            maxExecutions: logpointLimit.maxExecutions,
            breakpointId: logpointLimit.breakpointId,
            logs: logsFormatted,
          });
        }

        // Normal resume
        await targetCdpManager.resume();
        return createSuccessResponse('EXECUTION_RESUMED');
      }
    ),

    stepOver: createTool(
      'Step over to the next line (does not enter function calls)',
      executionSchema,
      async (args) => {
        const { connectionReason } = args;

        // Resolve connection if connectionReason is provided
        let targetCdpManager = cdpManager;
        if (connectionReason && resolveConnectionFromReason) {
          const resolved = await resolveConnectionFromReason(connectionReason);
          if (!resolved) {
            return createErrorResponse('CONNECTION_NOT_FOUND');
          }
          targetCdpManager = resolved.cdpManager;
        }

        await targetCdpManager.stepOver();
        return createSuccessResponse('EXECUTION_STEP_OVER');
      }
    ),

    stepInto: createTool(
      'Step into the next function call',
      executionSchema,
      async (args) => {
        const { connectionReason } = args;

        // Resolve connection if connectionReason is provided
        let targetCdpManager = cdpManager;
        if (connectionReason && resolveConnectionFromReason) {
          const resolved = await resolveConnectionFromReason(connectionReason);
          if (!resolved) {
            return createErrorResponse('CONNECTION_NOT_FOUND');
          }
          targetCdpManager = resolved.cdpManager;
        }

        await targetCdpManager.stepInto();
        return createSuccessResponse('EXECUTION_STEP_INTO');
      }
    ),

    stepOut: createTool(
      'Step out of the current function',
      executionSchema,
      async (args) => {
        const { connectionReason } = args;

        // Resolve connection if connectionReason is provided
        let targetCdpManager = cdpManager;
        if (connectionReason && resolveConnectionFromReason) {
          const resolved = await resolveConnectionFromReason(connectionReason);
          if (!resolved) {
            return createErrorResponse('CONNECTION_NOT_FOUND');
          }
          targetCdpManager = resolved.cdpManager;
        }

        await targetCdpManager.stepOut();
        return createSuccessResponse('EXECUTION_STEP_OUT');
      }
    ),
  };
}
