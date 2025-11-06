/**
 * Execution Control Tools
 */

import { z } from 'zod';
import { CDPManager } from '../cdp-manager.js';
import { createTool } from '../validation-helpers.js';

// Empty schema for tools with no parameters
const emptySchema = z.object({}).strict();

export function createExecutionTools(cdpManager: CDPManager) {
  return {
    pause: createTool(
      'Pause execution of the debugged program',
      emptySchema,
      async () => {
        await cdpManager.pause();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'Execution paused',
              }, null, 2),
            },
          ],
        };
      }
    ),

    resume: createTool(
      'Resume execution of the debugged program',
      emptySchema,
      async () => {
        await cdpManager.resume();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'Execution resumed',
              }, null, 2),
            },
          ],
        };
      }
    ),

    stepOver: createTool(
      'Step over to the next line (does not enter function calls)',
      emptySchema,
      async () => {
        await cdpManager.stepOver();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'Stepped over to next line',
              }, null, 2),
            },
          ],
        };
      }
    ),

    stepInto: createTool(
      'Step into the next function call',
      emptySchema,
      async () => {
        await cdpManager.stepInto();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'Stepped into function',
              }, null, 2),
            },
          ],
        };
      }
    ),

    stepOut: createTool(
      'Step out of the current function',
      emptySchema,
      async () => {
        await cdpManager.stepOut();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'Stepped out of function',
              }, null, 2),
            },
          ],
        };
      }
    ),
  };
}
