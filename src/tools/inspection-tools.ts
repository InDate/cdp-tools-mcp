/**
 * Inspection Tools
 */

import { CDPManager } from '../cdp-manager.js';
import { SourceMapHandler } from '../sourcemap-handler.js';

export function createInspectionTools(cdpManager: CDPManager, sourceMapHandler: SourceMapHandler) {
  return {
    getCallStack: {
      description: 'Get the current call stack when paused at a breakpoint',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async () => {
        const callStack = cdpManager.getCallStack();

        if (!callStack) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'Not currently paused at a breakpoint',
                }, null, 2),
              },
            ],
          };
        }

        // Try to map stack frames back to original sources
        const mappedStack = await Promise.all(
          callStack.map(async (frame) => {
            const original = await sourceMapHandler.mapToOriginal(
              frame.url,
              frame.location.lineNumber,
              frame.location.columnNumber
            );

            return {
              functionName: frame.functionName,
              location: original || {
                source: frame.url,
                line: frame.location.lineNumber,
                column: frame.location.columnNumber,
              },
              callFrameId: frame.callFrameId,
            };
          })
        );

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                callStack: mappedStack,
              }, null, 2),
            },
          ],
        };
      },
    },

    getVariables: {
      description: 'Get all variables in scope for a specific call frame',
      inputSchema: {
        type: 'object',
        properties: {
          callFrameId: {
            type: 'string',
            description: 'The call frame ID (get this from getCallStack)',
          },
          includeGlobal: {
            type: 'boolean',
            description: 'Include global scope variables (default: false, set true to enable filtering global)',
          },
          filter: {
            type: 'string',
            description: 'Regex pattern to filter variable names (only applies when includeGlobal is true)',
          },
        },
        required: ['callFrameId'],
      },
      handler: async (args: any) => {
        const { callFrameId, includeGlobal = false, filter } = args;

        try {
          const variables = await cdpManager.getVariables(callFrameId, includeGlobal, filter);

          // Group variables by scope type
          const groupedVariables: Record<string, any[]> = {};
          for (const variable of variables) {
            const scopeType = variable.scopeType || 'unknown';
            if (!groupedVariables[scopeType]) {
              groupedVariables[scopeType] = [];
            }
            groupedVariables[scopeType].push({
              name: variable.name,
              value: variable.value,
              type: variable.type,
            });
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  variables: groupedVariables,
                  totalCount: variables.length,
                  includeGlobal,
                  filter: filter || 'none',
                }, null, 2),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: `Failed to get variables: ${error}`,
                }, null, 2),
              },
            ],
          };
        }
      },
    },

    evaluateExpression: {
      description: 'Evaluate a JavaScript expression in the current context',
      inputSchema: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: 'The JavaScript expression to evaluate',
          },
          callFrameId: {
            type: 'string',
            description: 'Optional call frame ID to evaluate in a specific frame context',
          },
        },
        required: ['expression'],
      },
      handler: async (args: any) => {
        const { expression, callFrameId } = args;

        try {
          const result = await cdpManager.evaluateExpression(expression, callFrameId);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  expression,
                  result,
                }, null, 2),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: `Failed to evaluate expression: ${error}`,
                  expression,
                }, null, 2),
              },
            ],
          };
        }
      },
    },
  };
}
