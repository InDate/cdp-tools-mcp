/**
 * Inspection Tools
 */

import { z } from 'zod';
import { CDPManager } from '../cdp-manager.js';
import { SourceMapHandler } from '../sourcemap-handler.js';
import { createTool } from '../validation-helpers.js';
import { createSuccessResponse, createErrorResponse, formatCodeBlock } from '../messages.js';

/**
 * Check if line content appears to be a webpack eval wrapper (truncated or not)
 */
function isWebpackEvalLine(lineContent: string): boolean {
  return lineContent.startsWith('eval(__webpack_require__.');
}

/**
 * Extract the actual source line from a full webpack eval wrapper.
 * Webpack bundles code like: eval(__webpack_require__.ts("actual\\nsource\\ncode"))
 * This function extracts the inner content and finds the matching line.
 */
function extractSourceFromFullEvalLine(
  fullLineContent: string,
  pattern: string,
  caseSensitive: boolean
): { lineContent: string; innerLineNumber?: number } | null {
  // Extract content between the first ("  and last ")
  // Pattern: eval(__webpack_require__.XX("CONTENT"))
  const startMatch = fullLineContent.match(/^eval\(__webpack_require__\.\w+\(["'`]/);
  if (!startMatch) {
    return null;
  }

  const startIdx = startMatch[0].length;
  // Find the closing quote and parentheses - handle escaped quotes
  let endIdx = fullLineContent.length - 3; // Assume "))" at end, quote before that

  // Extract the inner content
  let innerContent = fullLineContent.substring(startIdx, endIdx);

  try {
    // Unescape the string (handles \\n, \\t, etc.)
    innerContent = innerContent
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\r/g, '\r')
      .replace(/\\\\/g, '\\')
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'");
  } catch {
    return null;
  }

  // Split into lines and find the one containing the pattern
  const lines = innerContent.split('\n');
  const flags = caseSensitive ? 'g' : 'gi';

  try {
    const regex = new RegExp(pattern, flags);
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        regex.lastIndex = 0; // Reset for next test
        return {
          lineContent: lines[i].trim(),
          innerLineNumber: i + 1, // 1-based line number within the eval content
        };
      }
      regex.lastIndex = 0; // Reset for next test
    }
  } catch {
    // If regex fails, try simple string match
    const searchPattern = caseSensitive ? pattern : pattern.toLowerCase();
    for (let i = 0; i < lines.length; i++) {
      const line = caseSensitive ? lines[i] : lines[i].toLowerCase();
      if (line.includes(searchPattern)) {
        return {
          lineContent: lines[i].trim(),
          innerLineNumber: i + 1,
        };
      }
    }
  }

  return null; // Pattern not found in inner content
}

// Consolidated inspection tool schema
const inspectionToolSchema = z.object({
  action: z.enum(['getCallStack', 'getVariables', 'evaluateExpression', 'searchCode', 'searchFunctions'])
    .describe('Inspection action: getCallStack (get call stack when paused), getVariables (get variables in call frame), evaluateExpression (evaluate JavaScript), searchCode (search code by pattern), searchFunctions (find function definitions)'),
  connectionReason: z.string().optional().describe('Connection reference (use the reference from launchChrome output, e.g., "unnamed-connection-default" or your renamed tab)'),

  // getVariables and evaluateExpression parameters
  callFrameId: z.string().optional().describe('Call frame ID (required for getVariables, optional for evaluateExpression)'),
  includeGlobal: z.boolean().optional().describe('Include global scope (for getVariables action, default: false)'),
  filter: z.string().optional().describe('Regex filter for variable names (for getVariables action) - applies to ALL scopes. Required when too many variables exist'),
  expandObjects: z.boolean().optional().describe('Expand objects/arrays (for getVariables and evaluateExpression actions, default: true)'),
  maxDepth: z.number().optional().describe('Max expansion depth (for getVariables and evaluateExpression actions, default: 2). Auto-reduced if response too large'),
  maxTokens: z.number().optional().describe('Max tokens for getVariables response (default: 1000). Depth auto-reduced to fit, filter required if still exceeded'),

  // evaluateExpression parameters
  expression: z.string().optional().describe('JavaScript expression (required for evaluateExpression action)'),

  // searchCode parameters
  pattern: z.string().optional().describe('Regex pattern (required for searchCode action)'),
  caseSensitive: z.boolean().optional().describe('Case sensitive (for searchCode and searchFunctions actions, default: false)'),
  isRegex: z.boolean().optional().describe('Treat as regex (for searchCode action, default: true)'),
  urlFilter: z.string().optional().describe('URL filter regex (for searchCode and searchFunctions actions)'),
  limit: z.number().optional().describe('Max results (for searchCode action default: 100, for searchFunctions default: 50)'),

  // searchFunctions parameters
  functionName: z.string().optional().describe('Function name (required for searchFunctions action)'),
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
    inspect: createTool(
      'Inspect and debug code. Actions: getCallStack (get call stack when paused), getVariables (get variables in call frame), evaluateExpression (evaluate JavaScript), searchCode (search code by pattern), searchFunctions (find function definitions)',
      inspectionToolSchema,
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

        switch (action) {
          case 'getCallStack': {
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

          case 'getVariables': {
            const { callFrameId, includeGlobal = false, filter, expandObjects = true, maxDepth = 2, maxTokens = 1000 } = args;

            if (!callFrameId) {
              return createErrorResponse('MISSING_PARAMETER', {
                action: 'getVariables',
                missing: 'callFrameId',
                message: 'Provide a valid call frame ID from the call stack'
              });
            }

            try {
              const result = await targetCdpManager.getVariables(callFrameId, includeGlobal, filter, expandObjects, maxDepth, maxTokens);
              const { variables, totalCount, usedDepth, requestedDepth, tokenEstimate, requiresFilter } = result;

              // If filter is required due to size, return error with guidance
              if (requiresFilter) {
                return createErrorResponse('VARIABLES_TOO_LARGE', {
                  totalCount,
                  tokenEstimate,
                });
              }

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

              // Use warning if depth was reduced
              if (usedDepth < requestedDepth) {
                return createSuccessResponse('VARIABLES_DEPTH_REDUCED', {
                  callFrameId,
                  totalCount,
                  requestedDepth,
                  usedDepth,
                  filter: filter || undefined,
                  includeGlobal: includeGlobal || undefined,
                }, groupedVariables);
              }

              return createSuccessResponse('VARIABLES_SUCCESS', {
                callFrameId,
                returnedCount: variables.length,
                totalCount,
                filter: filter || undefined,
                includeGlobal: includeGlobal || undefined,
              }, groupedVariables);
            } catch (error) {
              return createErrorResponse('CALL_FRAME_NOT_FOUND', {
                callFrameId,
              });
            }
          }

          case 'evaluateExpression': {
            const { expression, callFrameId, expandObjects = true, maxDepth = 2 } = args;

            if (!expression) {
              return createErrorResponse('MISSING_PARAMETER', {
                action: 'evaluateExpression',
                missing: 'expression',
                message: 'Provide a JavaScript expression to evaluate'
              });
            }

            try {
              const result = await targetCdpManager.evaluateExpression(expression, callFrameId, expandObjects, maxDepth);

              // Format result based on type
              let formattedResult: string;
              if (result === undefined || result === 'undefined') {
                formattedResult = '```\nundefined\n```';
              } else if (result === null || result === 'null') {
                formattedResult = '```\nnull\n```';
              } else if (typeof result === 'string') {
                formattedResult = `\`\`\`\n${result}\n\`\`\``;
              } else {
                // For objects/arrays, use JSON formatting
                formattedResult = `\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``;
              }

              return createSuccessResponse('EVALUATE_EXPRESSION_SUCCESS', {
                expression,
                context: callFrameId ? `Call frame ${callFrameId}` : 'Global context',
                result: formattedResult
              });
            } catch (error) {
              return createErrorResponse('EVALUATE_EXPRESSION_FAILED', {
                expression,
                error: String(error),
              });
            }
          }

          case 'searchCode': {
            const { pattern, caseSensitive = false, isRegex = true, urlFilter, limit = 100 } = args;

            if (!pattern) {
              return createErrorResponse('MISSING_PARAMETER', {
                action: 'searchCode',
                missing: 'pattern',
                message: 'Provide a regex pattern to search for in the code'
              });
            }

            if (!cdpManager.isConnected()) {
              return createErrorResponse('DEBUGGER_NOT_CONNECTED');
            }

            try {
              const allScripts = cdpManager.getAllScripts();
              let scriptsToSearch = allScripts;

              // Filter by URL if provided
              if (urlFilter) {
                try {
                  const urlRegex = new RegExp(urlFilter);
                  scriptsToSearch = allScripts.filter(s => urlRegex.test(s.url));
                } catch (error) {
                  return createErrorResponse('SOURCE_CODE_FAILED', { error: `Invalid URL filter regex: ${error}` });
                }
              }

              const allResults: Array<{ url: string; scriptId: string; lineNumber: number; lineContent: string }> = [];

              for (const script of scriptsToSearch) {
                if (allResults.length >= limit) break;

                const matches = await cdpManager.searchInScript(
                  script.scriptId,
                  pattern,
                  caseSensitive,
                  isRegex
                );

                for (const match of matches) {
                  let lineContent: string;
                  let displayLineNumber = match.lineNumber + 1; // Convert to 1-based

                  // Check if this is a webpack eval line (truncated content starts with eval)
                  if (isWebpackEvalLine(match.lineContent)) {
                    // Fetch the full line content from the script
                    const fullLine = await targetCdpManager.getScriptLine(script.scriptId, match.lineNumber);
                    if (fullLine) {
                      const extracted = extractSourceFromFullEvalLine(fullLine, pattern, caseSensitive);
                      if (extracted) {
                        lineContent = extracted.lineContent;
                      } else {
                        // Couldn't extract, use truncated original
                        lineContent = match.lineContent;
                      }
                    } else {
                      lineContent = match.lineContent;
                    }
                  } else {
                    // Regular code, use as-is
                    lineContent = match.lineContent;
                  }

                  // Truncate line content to avoid huge responses from minified code
                  const MAX_LINE_LENGTH = 200;
                  if (lineContent.length > MAX_LINE_LENGTH) {
                    lineContent = lineContent.substring(0, MAX_LINE_LENGTH) + '...';
                  }

                  allResults.push({
                    url: script.url,
                    scriptId: script.scriptId,
                    lineNumber: displayLineNumber,
                    lineContent,
                  });

                  if (allResults.length >= limit) break;
                }
              }

              return createSuccessResponse('CODE_SEARCH_RESULTS', {
                count: allResults.length.toString()
              }, {
                pattern,
                caseSensitive,
                scriptsSearched: scriptsToSearch.length,
                totalScripts: allScripts.length,
                results: allResults,
              });
            } catch (error) {
              return createErrorResponse('SOURCE_CODE_FAILED', { error: `${error}` });
            }
          }

          case 'searchFunctions': {
            const { functionName, caseSensitive = false, urlFilter, limit = 50 } = args;

            if (!functionName) {
              return createErrorResponse('MISSING_PARAMETER', {
                action: 'searchFunctions',
                missing: 'functionName',
                message: 'Provide a function name to search for'
              });
            }

            if (!cdpManager.isConnected()) {
              return createErrorResponse('DEBUGGER_NOT_CONNECTED');
            }

            try {
              const allScripts = cdpManager.getAllScripts();
              let scriptsToSearch = allScripts;

              // Filter by URL if provided
              if (urlFilter) {
                try {
                  const urlRegex = new RegExp(urlFilter);
                  scriptsToSearch = allScripts.filter(s => urlRegex.test(s.url));
                } catch (error) {
                  return createErrorResponse('SOURCE_CODE_FAILED', { error: `Invalid URL filter regex: ${error}` });
                }
              }

              // Build pattern to match: function name( or const name = or let name =
              const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const pattern = caseSensitive
                ? `(function\\s+${escapedName}\\s*\\(|const\\s+${escapedName}\\s*=|let\\s+${escapedName}\\s*=|${escapedName}\\s*:\\s*function|${escapedName}\\s*:\\s*\\(|${escapedName}\\s*=\\s*\\()`
                : `(function\\s+${escapedName}\\s*\\(|const\\s+${escapedName}\\s*=|let\\s+${escapedName}\\s*=|${escapedName}\\s*:\\s*function|${escapedName}\\s*:\\s*\\(|${escapedName}\\s*=\\s*\\()`;

              const allResults: Array<{ url: string; scriptId: string; lineNumber: number; lineContent: string }> = [];

              for (const script of scriptsToSearch) {
                if (allResults.length >= limit) break;

                const matches = await cdpManager.searchInScript(
                  script.scriptId,
                  pattern,
                  caseSensitive,
                  true // always use regex
                );

                for (const match of matches) {
                  let lineContent: string;
                  let displayLineNumber = match.lineNumber + 1; // Convert to 1-based

                  // Check if this is a webpack eval line (truncated content starts with eval)
                  if (isWebpackEvalLine(match.lineContent)) {
                    // Fetch the full line content from the script
                    const fullLine = await targetCdpManager.getScriptLine(script.scriptId, match.lineNumber);
                    if (fullLine) {
                      const extracted = extractSourceFromFullEvalLine(fullLine, pattern, caseSensitive);
                      if (extracted) {
                        lineContent = extracted.lineContent;
                      } else {
                        // Couldn't extract, use truncated original
                        lineContent = match.lineContent.trim();
                      }
                    } else {
                      lineContent = match.lineContent.trim();
                    }
                  } else {
                    // Regular code, use as-is
                    lineContent = match.lineContent.trim();
                  }

                  // Truncate line content to avoid huge responses from minified code
                  const MAX_LINE_LENGTH = 200;
                  if (lineContent.length > MAX_LINE_LENGTH) {
                    lineContent = lineContent.substring(0, MAX_LINE_LENGTH) + '...';
                  }

                  allResults.push({
                    url: script.url,
                    scriptId: script.scriptId,
                    lineNumber: displayLineNumber,
                    lineContent,
                  });

                  if (allResults.length >= limit) break;
                }
              }

              return createSuccessResponse('FUNCTION_SEARCH_RESULTS', {
                count: allResults.length.toString(),
                functionName
              }, {
                caseSensitive,
                scriptsSearched: scriptsToSearch.length,
                totalScripts: allScripts.length,
                results: allResults,
              });
            } catch (error) {
              return createErrorResponse('SOURCE_CODE_FAILED', { error: `${error}` });
            }
          }

          default:
            return createErrorResponse('INVALID_ACTION', {
              action,
              validActions: 'getCallStack, getVariables, evaluateExpression, searchCode, searchFunctions',
            });
        }
      }
    ),
  };
}
