/**
 * Inspection Tools
 */

import { z } from 'zod';
import { CDPManager } from '../cdp-manager.js';
import { SourceMapHandler } from '../sourcemap-handler.js';
import { createTool } from '../validation-helpers.js';

// Empty schema for tools with no parameters
const emptySchema = z.object({}).strict();

// Schema for getVariables
const getVariablesSchema = z.object({
  callFrameId: z.string().describe('The call frame ID (get this from getCallStack)'),
  includeGlobal: z.boolean().default(false).describe('Include global scope variables (default: false, set true to enable filtering global)'),
  filter: z.string().optional().describe('Regex pattern to filter variable names (only applies when includeGlobal is true)'),
  expandObjects: z.boolean().default(true).describe('Expand object/array contents to show actual values instead of just type descriptions (default: true)'),
  maxDepth: z.number().default(2).describe('Maximum depth for object/array expansion (default: 2, prevents infinite recursion)'),
}).strict();

// Schema for evaluateExpression
const evaluateExpressionSchema = z.object({
  expression: z.string().describe('The JavaScript expression to evaluate'),
  callFrameId: z.string().optional().describe('Optional call frame ID to evaluate in a specific frame context'),
  expandObjects: z.boolean().default(true).describe('Expand object/array contents in the result (default: true)'),
  maxDepth: z.number().default(2).describe('Maximum depth for object/array expansion (default: 2)'),
}).strict();

export function createInspectionTools(cdpManager: CDPManager, sourceMapHandler: SourceMapHandler) {
  return {
    getCallStack: createTool(
      'Get the current call stack when paused at a breakpoint',
      emptySchema,
      async () => {
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
      }
    ),

    getVariables: createTool(
      'Get all variables in scope for a specific call frame',
      getVariablesSchema,
      async (args) => {
        const { callFrameId, includeGlobal, filter, expandObjects, maxDepth } = args;

        try {
          const variables = await cdpManager.getVariables(callFrameId, includeGlobal, filter, expandObjects, maxDepth);

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
      }
    ),

    evaluateExpression: createTool(
      'Evaluate a JavaScript expression in the current context',
      evaluateExpressionSchema,
      async (args) => {
        const { expression, callFrameId, expandObjects, maxDepth } = args;

        try {
          const result = await cdpManager.evaluateExpression(expression, callFrameId, expandObjects, maxDepth);

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
      }
    ),
  };
}
