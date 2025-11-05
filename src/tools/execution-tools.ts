/**
 * Execution Control Tools
 */

import { CDPManager } from '../cdp-manager.js';

export function createExecutionTools(cdpManager: CDPManager) {
  return {
    pause: {
      description: 'Pause execution of the debugged program',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async () => {
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
      },
    },

    resume: {
      description: 'Resume execution of the debugged program',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async () => {
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
      },
    },

    stepOver: {
      description: 'Step over to the next line (does not enter function calls)',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async () => {
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
      },
    },

    stepInto: {
      description: 'Step into the next function call',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async () => {
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
      },
    },

    stepOut: {
      description: 'Step out of the current function',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async () => {
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
      },
    },
  };
}
