/**
 * Execution Control Tools
 */

import { z } from 'zod';
import { CDPManager } from '../cdp-manager.js';
import { createTool } from '../validation-helpers.js';
import { createSuccessResponse, createErrorResponse, formatCodeBlock } from '../messages.js';

// Empty schema for tools with no parameters
const emptySchema = z.object({}).strict();

export function createExecutionTools(cdpManager: CDPManager) {
  return {
    pause: createTool(
      'Pause execution of the debugged program',
      emptySchema,
      async () => {
        await cdpManager.pause();
        return createSuccessResponse('EXECUTION_PAUSED');
      }
    ),

    resume: createTool(
      'Resume execution of the debugged program',
      emptySchema,
      async () => {
        // Check if execution was paused due to logpoint limit exceeded
        const logpointLimit = cdpManager.getLogpointLimitExceeded();

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
        await cdpManager.resume();
        return createSuccessResponse('EXECUTION_RESUMED');
      }
    ),

    stepOver: createTool(
      'Step over to the next line (does not enter function calls)',
      emptySchema,
      async () => {
        await cdpManager.stepOver();
        return createSuccessResponse('EXECUTION_STEP_OVER');
      }
    ),

    stepInto: createTool(
      'Step into the next function call',
      emptySchema,
      async () => {
        await cdpManager.stepInto();
        return createSuccessResponse('EXECUTION_STEP_INTO');
      }
    ),

    stepOut: createTool(
      'Step out of the current function',
      emptySchema,
      async () => {
        await cdpManager.stepOut();
        return createSuccessResponse('EXECUTION_STEP_OUT');
      }
    ),
  };
}
