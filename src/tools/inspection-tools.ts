/**
 * Inspection Tools
 */

import { z } from 'zod';
import { CDPManager } from '../cdp-manager.js';
import { SourceMapHandler } from '../sourcemap-handler.js';
import { createTool } from '../validation-helpers.js';
import { createSuccessResponse, createErrorResponse, formatCodeBlock } from '../messages.js';

// Schema for getCallStack
const getCallStackSchema = z.object({
  connectionReason: z.string().optional().describe('Brief reason for needing this browser connection (3 descriptive words recommended). Requires existing tab or connection. Only needed for browser debugging, not Node.js.'),
}).strict();

// Schema for getVariables
const getVariablesSchema = z.object({
  callFrameId: z.string().describe('The call frame ID (get this from getCallStack)'),
  includeGlobal: z.boolean().default(false).describe('Include global scope variables (default: false, set true to enable filtering global)'),
  filter: z.string().optional().describe('Regex pattern to filter variable names (only applies when includeGlobal is true)'),
  expandObjects: z.boolean().default(true).describe('Expand object/array contents to show actual values instead of just type descriptions (default: true)'),
  maxDepth: z.number().default(2).describe('Maximum depth for object/array expansion (default: 2, prevents infinite recursion)'),
  connectionReason: z.string().optional().describe('Brief reason for needing this browser connection (3 descriptive words recommended). Requires existing tab or connection. Only needed for browser debugging, not Node.js.'),
}).strict();

// Schema for evaluateExpression
const evaluateExpressionSchema = z.object({
  expression: z.string().describe('The JavaScript expression to evaluate'),
  callFrameId: z.string().optional().describe('Optional call frame ID to evaluate in a specific frame context'),
  expandObjects: z.boolean().default(true).describe('Expand object/array contents in the result (default: true)'),
  maxDepth: z.number().default(2).describe('Maximum depth for object/array expansion (default: 2)'),
  connectionReason: z.string().optional().describe('Brief reason for needing this browser connection (3 descriptive words recommended). Requires existing tab or connection. Only needed for browser debugging, not Node.js.'),
}).strict();

// Schema for searchCode
const searchCodeSchema = z.object({
  pattern: z.string().describe('Regex pattern to search for in code'),
  caseSensitive: z.boolean().default(false).describe('Case sensitive search (default: false)'),
  isRegex: z.boolean().default(true).describe('Treat pattern as regex (default: true)'),
  urlFilter: z.string().optional().describe('Optional regex to filter scripts by URL'),
  limit: z.number().default(100).describe('Maximum number of results to return (default: 100)'),
}).strict();

// Schema for searchFunctions
const searchFunctionsSchema = z.object({
  functionName: z.string().describe('Function name to search for'),
  caseSensitive: z.boolean().default(false).describe('Case sensitive search (default: false)'),
  urlFilter: z.string().optional().describe('Optional regex to filter scripts by URL'),
  limit: z.number().default(50).describe('Maximum number of results to return (default: 50)'),
}).strict();

export function createInspectionTools(
  cdpManager: CDPManager,
  sourceMapHandler: SourceMapHandler,
  resolveConnectionFromReason?: (connectionReason: string) => Promise<{
    connection: any;
    cdpManager: CDPManager;
    puppeteerManager: any;
    consoleMonitor: any;
    networkMonitor: any;
  } | null>
) {
  return {
    getCallStack: createTool(
      'Get the current call stack when paused at a breakpoint',
      getCallStackSchema,
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

        const callStack = targetCdpManager.getCallStack();

        if (!callStack) {
          return createErrorResponse('NOT_PAUSED');
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

        // Format paused location from first frame
        const pausedLocation = mappedStack.length > 0
          ? `${mappedStack[0].location.source}:${mappedStack[0].location.line}`
          : undefined;

        return createSuccessResponse('CALL_STACK_SUCCESS', {
          pausedLocation,
          frameCount: mappedStack.length,
        }, mappedStack);
      }
    ),

    getVariables: createTool(
      'Get all variables in scope for a specific call frame',
      getVariablesSchema,
      async (args) => {
        const { callFrameId, includeGlobal, filter, expandObjects, maxDepth, connectionReason } = args;

        // Resolve connection if connectionReason is provided
        let targetCdpManager = cdpManager;
        if (connectionReason && resolveConnectionFromReason) {
          const resolved = await resolveConnectionFromReason(connectionReason);
          if (!resolved) {
            return createErrorResponse('CONNECTION_NOT_FOUND');
          }
          targetCdpManager = resolved.cdpManager;
        }

        try {
          const variables = await targetCdpManager.getVariables(callFrameId, includeGlobal, filter, expandObjects, maxDepth);

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

          return createSuccessResponse('VARIABLES_SUCCESS', {
            callFrameId,
            totalCount: variables.length,
            filter: filter || undefined,
            includeGlobal: includeGlobal || undefined,
          }, groupedVariables);
        } catch (error) {
          return createErrorResponse('CALL_FRAME_NOT_FOUND', {
            callFrameId,
          });
        }
      }
    ),

    evaluateExpression: createTool(
      'Evaluate a JavaScript expression in the current context',
      evaluateExpressionSchema,
      async (args) => {
        const { expression, callFrameId, expandObjects, maxDepth, connectionReason } = args;

        // Resolve connection if connectionReason is provided
        let targetCdpManager = cdpManager;
        if (connectionReason && resolveConnectionFromReason) {
          const resolved = await resolveConnectionFromReason(connectionReason);
          if (!resolved) {
            return createErrorResponse('CONNECTION_NOT_FOUND');
          }
          targetCdpManager = resolved.cdpManager;
        }

        try {
          const result = await targetCdpManager.evaluateExpression(expression, callFrameId, expandObjects, maxDepth);

          // The manual construction in evaluateExpression was intentionally added to
          // solve a specific problem - ensuring that expression results are always visible with proper
          // formatting and context. This is a legitimate use case for manual construction, not a bug.
          
          let markdown = `Expression evaluated successfully\n\n`;
          markdown += `**Expression:** \`${expression}\`\n`;
          markdown += `**Context:** ${callFrameId ? `Call frame ${callFrameId}` : 'Global context'}\n\n`;
          markdown += `**Result:**\n`;

          // Format result based on type
          if (result === undefined || result === 'undefined') {
            markdown += '```\nundefined\n```';
          } else if (result === null || result === 'null') {
            markdown += '```\nnull\n```';
          } else if (typeof result === 'string') {
            markdown += `\`\`\`\n${result}\n\`\`\``;
          } else {
            // For objects/arrays, use JSON formatting
            markdown += `\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``;
          }

          return {
            content: [
              {
                type: 'text',
                text: markdown,
              },
            ],
          };
        } catch (error) {
          return createErrorResponse('EVALUATE_EXPRESSION_FAILED', {
            expression,
            error: String(error),
          });
        }
      }
    ),

    searchCode: createTool(
      'Search for a pattern across all loaded scripts using regex. Useful for finding code, functions, or specific patterns in the runtime.',
      searchCodeSchema,
      async (args) => {
        if (!cdpManager.isConnected()) {
          return createErrorResponse('DEBUGGER_NOT_CONNECTED');
        }

        try {
          const allScripts = cdpManager.getAllScripts();
          let scriptsToSearch = allScripts;

          // Filter by URL if provided
          if (args.urlFilter) {
            try {
              const urlRegex = new RegExp(args.urlFilter);
              scriptsToSearch = allScripts.filter(s => urlRegex.test(s.url));
            } catch (error) {
              return createErrorResponse('SOURCE_CODE_FAILED', { error: `Invalid URL filter regex: ${error}` });
            }
          }

          const allResults: Array<{ url: string; scriptId: string; lineNumber: number; lineContent: string }> = [];

          for (const script of scriptsToSearch) {
            if (allResults.length >= args.limit) break;

            const matches = await cdpManager.searchInScript(
              script.scriptId,
              args.pattern,
              args.caseSensitive,
              args.isRegex
            );

            for (const match of matches) {
              allResults.push({
                url: script.url,
                scriptId: script.scriptId,
                lineNumber: match.lineNumber + 1, // Convert to 1-based
                lineContent: match.lineContent,
              });

              if (allResults.length >= args.limit) break;
            }
          }

          return createSuccessResponse('CODE_SEARCH_RESULTS', {
            count: allResults.length.toString()
          }, {
            pattern: args.pattern,
            caseSensitive: args.caseSensitive,
            scriptsSearched: scriptsToSearch.length,
            totalScripts: allScripts.length,
            results: allResults,
          });
        } catch (error) {
          return createErrorResponse('SOURCE_CODE_FAILED', { error: `${error}` });
        }
      }
    ),

    searchFunctions: createTool(
      'Find function definitions across all loaded scripts. Searches for function declarations, arrow functions, and const/let function assignments.',
      searchFunctionsSchema,
      async (args) => {
        if (!cdpManager.isConnected()) {
          return createErrorResponse('DEBUGGER_NOT_CONNECTED');
        }

        try {
          const allScripts = cdpManager.getAllScripts();
          let scriptsToSearch = allScripts;

          // Filter by URL if provided
          if (args.urlFilter) {
            try {
              const urlRegex = new RegExp(args.urlFilter);
              scriptsToSearch = allScripts.filter(s => urlRegex.test(s.url));
            } catch (error) {
              return createErrorResponse('SOURCE_CODE_FAILED', { error: `Invalid URL filter regex: ${error}` });
            }
          }

          // Build pattern to match: function name( or const name = or let name =
          const escapedName = args.functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const pattern = args.caseSensitive
            ? `(function\\s+${escapedName}\\s*\\(|const\\s+${escapedName}\\s*=|let\\s+${escapedName}\\s*=|${escapedName}\\s*:\\s*function|${escapedName}\\s*:\\s*\\(|${escapedName}\\s*=\\s*\\()`
            : `(function\\s+${escapedName}\\s*\\(|const\\s+${escapedName}\\s*=|let\\s+${escapedName}\\s*=|${escapedName}\\s*:\\s*function|${escapedName}\\s*:\\s*\\(|${escapedName}\\s*=\\s*\\()`;

          const allResults: Array<{ url: string; scriptId: string; lineNumber: number; lineContent: string }> = [];

          for (const script of scriptsToSearch) {
            if (allResults.length >= args.limit) break;

            const matches = await cdpManager.searchInScript(
              script.scriptId,
              pattern,
              args.caseSensitive,
              true // always use regex
            );

            for (const match of matches) {
              allResults.push({
                url: script.url,
                scriptId: script.scriptId,
                lineNumber: match.lineNumber + 1, // Convert to 1-based
                lineContent: match.lineContent.trim(),
              });

              if (allResults.length >= args.limit) break;
            }
          }

          return createSuccessResponse('FUNCTION_SEARCH_RESULTS', {
            count: allResults.length.toString(),
            functionName: args.functionName
          }, {
            caseSensitive: args.caseSensitive,
            scriptsSearched: scriptsToSearch.length,
            totalScripts: allScripts.length,
            results: allResults,
          });
        } catch (error) {
          return createErrorResponse('SOURCE_CODE_FAILED', { error: `${error}` });
        }
      }
    ),
  };
}
