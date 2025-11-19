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
  connectionReason: z.string().optional().describe('Connection reference'),
}).strict();

// Schema for getVariables
const getVariablesSchema = z.object({
  callFrameId: z.string().describe('Call frame ID'),
  includeGlobal: z.boolean().default(false).describe('Include global scope'),
  filter: z.string().optional().describe('Regex filter for variable names'),
  expandObjects: z.boolean().default(true).describe('Expand objects/arrays'),
  maxDepth: z.number().default(2).describe('Max expansion depth'),
  connectionReason: z.string().optional().describe('Connection reference'),
}).strict();

// Schema for evaluateExpression
const evaluateExpressionSchema = z.object({
  expression: z.string().describe('JavaScript expression'),
  callFrameId: z.string().optional().describe('Call frame ID'),
  expandObjects: z.boolean().default(true).describe('Expand objects/arrays'),
  maxDepth: z.number().default(2).describe('Max expansion depth'),
  connectionReason: z.string().optional().describe('Connection reference'),
}).strict();

// Schema for searchCode
const searchCodeSchema = z.object({
  pattern: z.string().describe('Regex pattern'),
  caseSensitive: z.boolean().default(false).describe('Case sensitive'),
  isRegex: z.boolean().default(true).describe('Treat as regex'),
  urlFilter: z.string().optional().describe('URL filter regex'),
  limit: z.number().default(100).describe('Max results'),
}).strict();

// Schema for searchFunctions
const searchFunctionsSchema = z.object({
  functionName: z.string().describe('Function name'),
  caseSensitive: z.boolean().default(false).describe('Case sensitive'),
  urlFilter: z.string().optional().describe('URL filter regex'),
  limit: z.number().default(50).describe('Max results'),
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
      'Get call stack when paused',
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
      'Get variables in call frame scope',
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
      'Evaluate JavaScript expression',
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
      'Search code by regex pattern',
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
      'Find function definitions',
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
