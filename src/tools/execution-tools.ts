/**
 * Execution Control Tools
 */

import { z } from 'zod';
import { CDPManager } from '../cdp-manager.js';
import { createTool } from '../validation-helpers.js';
import { createSuccessResponse, createErrorResponse, formatCodeBlock } from '../messages.js';

// Consolidated schema with action parameter
const executionSchema = z.object({
  action: z.enum(['pause', 'resume', 'stepOver', 'stepInto', 'stepOut']).describe('Execution control action to perform'),
  connectionReason: z.string().optional().describe('Connection reference (use the reference from launchChrome output, e.g., "unnamed-connection-default" or your renamed tab)'),
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
    execution: createTool(
      'Control execution flow when paused at breakpoints. Actions: pause (pause execution), resume (resume execution), stepOver (step to next line), stepInto (step into function call), stepOut (step out of current function)',
      executionSchema,
      async (args) => {
        const { action, connectionReason } = args;

        // Resolve connection if connectionReason is provided
        let targetCdpManager = cdpManager;
        if (connectionReason && resolveConnectionFromReason) {
          const resolved = await resolveConnectionFromReason(connectionReason);
          if (!resolved) {
            return createErrorResponse('CONNECTION_NOT_FOUND');
          }
          targetCdpManager = resolved.cdpManager;
        }

        // Handle each action
        switch (action) {
          case 'pause':
            await targetCdpManager.pause();
            return createSuccessResponse('EXECUTION_PAUSED');

          case 'resume': {
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

          case 'stepOver':
            await targetCdpManager.stepOver();
            return createSuccessResponse('EXECUTION_STEP_OVER');

          case 'stepInto':
            await targetCdpManager.stepInto();
            return createSuccessResponse('EXECUTION_STEP_INTO');

          case 'stepOut':
            await targetCdpManager.stepOut();
            return createSuccessResponse('EXECUTION_STEP_OUT');

          default:
            return createErrorResponse('INVALID_ACTION', { action });
        }
      }
    ),
  };
}
