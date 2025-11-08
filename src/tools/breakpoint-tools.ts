/**
 * Breakpoint Management Tools
 */

import { z } from 'zod';
import { CDPManager } from '../cdp-manager.js';
import { SourceMapHandler } from '../sourcemap-handler.js';
import { createTool } from '../validation-helpers.js';

// Schema definitions
const setBreakpointSchema = z.object({
  url: z.string().describe('The file URL or path (e.g., file:///path/to/file.js or http://localhost:3000/app.js)'),
  lineNumber: z.number().describe('The line number (1-based)'),
  columnNumber: z.number().optional().describe('The column number (optional, 0-based)'),
  condition: z.string().optional().describe('Optional condition expression - breakpoint only triggers when this evaluates to true'),
}).strict();

const removeBreakpointSchema = z.object({
  breakpointId: z.string().describe('The breakpoint ID to remove'),
}).strict();

const listBreakpointsSchema = z.object({}).strict();

const setLogpointSchema = z.object({
  url: z.string().describe('The file URL or path'),
  lineNumber: z.number().describe('The line number (1-based)'),
  columnNumber: z.number().optional().describe('Optional column number (1-based). If not provided, CDP will choose the best execution point on the line.'),
  logMessage: z.string().describe('Message to log. Use {expression} for variable interpolation, e.g., "User: {user.name} ID: {user.id}"'),
  condition: z.string().optional().describe('Optional condition - only log when this evaluates to true'),
  includeCallStack: z.boolean().default(false).describe('Include call stack in log output (default: false)'),
  includeVariables: z.boolean().default(false).describe('Include local variables in log output (default: false)'),
}).strict();

const validateLogpointSchema = z.object({
  url: z.string().describe('The file URL or path'),
  lineNumber: z.number().describe('The line number (1-based)'),
  columnNumber: z.number().optional().describe('Optional column number (1-based). If not provided, CDP will choose the execution point.'),
  logMessage: z.string().describe('Message to log with {expression} interpolation'),
  timeout: z.number().default(2000).describe('Maximum time to wait for code execution in milliseconds (default: 2000ms)'),
}).strict();

export function createBreakpointTools(cdpManager: CDPManager, sourceMapHandler: SourceMapHandler) {
  return {
    setBreakpoint: createTool(
      'Set a breakpoint at a specific file and line number. Supports conditional breakpoints that only pause when a condition is true.',
      setBreakpointSchema,
      async (args) => {
        const { url, lineNumber, columnNumber } = args;

        // Check connection and runtime type
        const runtimeType = cdpManager.getRuntimeType();
        const isConnected = cdpManager.isConnected();

        if (!isConnected) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: 'Not connected to debugger',
                  suggestion: 'Use connectDebugger() first to connect to a Chrome or Node.js debugger',
                }, null, 2),
              },
            ],
          };
        }

        // Try to map through source maps if this is a TypeScript file
        let targetUrl = url;
        let targetLine = lineNumber;
        let targetColumn = columnNumber;

        if (url.endsWith('.ts')) {
          const mapped = await sourceMapHandler.mapToGenerated(url, lineNumber, columnNumber || 0);
          if (mapped) {
            targetUrl = mapped.generatedFile;
            targetLine = mapped.line;
            targetColumn = mapped.column;
          }
        }

        try {
          const breakpoint = await cdpManager.setBreakpoint(targetUrl, targetLine, targetColumn, args.condition);

          // Inject clickable console link
          const icon = args.condition ? '🔶' : '🔴';
          const label = args.condition ? 'Conditional breakpoint set at' : 'Breakpoint set at';
          await cdpManager.injectConsoleLink(targetUrl, targetLine, `${icon} ${label}`);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  breakpointId: breakpoint.breakpointId,
                  location: breakpoint.location,
                  originalLocation: breakpoint.originalLocation,
                  condition: args.condition || 'none',
                  message: `${args.condition ? 'Conditional breakpoint' : 'Breakpoint'} set at ${targetUrl}:${targetLine}`,
                  consoleLink: `Console link injected - click in browser to open source`,
                  runtimeType,
                  note: runtimeType === 'chrome'
                    ? `${args.condition ? 'Conditional breakpoint' : 'Breakpoint'} set in Chrome browser runtime`
                    : `${args.condition ? 'Conditional breakpoint' : 'Breakpoint'} set in Node.js runtime`,
                }, null, 2),
              },
            ],
          };
        } catch (error: any) {
          // Provide helpful error message with context
          let helpMessage = '';

          if (runtimeType === 'chrome' && (url.includes('/dist/') || url.includes('index.js'))) {
            helpMessage = 'TIP: You are connected to Chrome (browser) but trying to set a breakpoint on what looks like server code. ' +
                          'If this is Node.js server code, you need to connect to the Node.js debugger separately using connectDebugger({port: 9229}).';
          } else if (runtimeType === 'node' && url.includes('/public/')) {
            helpMessage = 'TIP: You are connected to Node.js but trying to set a breakpoint on what looks like browser code. ' +
                          'You may need to connect to Chrome using connectDebugger({port: 9222}) for client-side debugging.';
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: `Failed to set breakpoint: ${error.message}`,
                  runtimeType,
                  url: targetUrl,
                  lineNumber: targetLine,
                  ...(helpMessage && { help: helpMessage }),
                  suggestion: 'Verify that:\n' +
                             '1. The file has been loaded by the runtime\n' +
                             '2. The URL matches the runtime type (Chrome vs Node.js)\n' +
                             '3. Line number is valid\n' +
                             '4. You are connected to the correct debugger',
                }, null, 2),
              },
            ],
          };
        }
      }
    ),

    removeBreakpoint: createTool(
      'Remove a specific breakpoint by its ID',
      removeBreakpointSchema,
      async (args) => {
        const { breakpointId } = args;
        await cdpManager.removeBreakpoint(breakpointId);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: `Breakpoint ${breakpointId} removed`,
              }, null, 2),
            },
          ],
        };
      }
    ),

    listBreakpoints: createTool(
      'List all active breakpoints',
      listBreakpointsSchema,
      async () => {
        const breakpoints = cdpManager.getBreakpoints();
        const counts = cdpManager.getBreakpointCounts();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                breakpoints: breakpoints.map(bp => ({
                  breakpointId: bp.breakpointId,
                  location: bp.location,
                  originalLocation: bp.originalLocation,
                  type: bp.isLogpoint ? 'logpoint' : 'breakpoint',
                })),
                totalCount: counts.total,
                breakpointCount: counts.breakpoints,
                logpointCount: counts.logpoints,
              }, null, 2),
            },
          ],
        };
      }
    ),

    validateLogpoint: createTool(
      'Validate a logpoint expression before setting it. Tests if the expressions in the log message can be evaluated and provides helpful feedback.',
      validateLogpointSchema,
      async (args) => {
        const { url, lineNumber, columnNumber, logMessage, timeout } = args;

        // Parse logMessage to extract expressions
        const expressionMatches = logMessage.matchAll(/\{([^}]+)\}/g);
        const expressions: string[] = [];
        for (const match of expressionMatches) {
          expressions.push(match[1]);
        }

        if (expressions.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  valid: true,
                  message: 'No expressions to validate in log message',
                  logMessage,
                }, null, 2),
              },
            ],
          };
        }

        // Set a temporary breakpoint to test the expressions
        try {
          const tempBreakpoint = await cdpManager.setBreakpoint(url, lineNumber, columnNumber);

          // Get actual location from CDP (0-based)
          const actualCdpLine = tempBreakpoint.location.lineNumber;
          const actualCdpColumn = tempBreakpoint.location.columnNumber;

          // Convert to 1-based for user display
          const actualLineUser = actualCdpLine + 1;
          const actualColumnUser = actualCdpColumn !== undefined ? actualCdpColumn + 1 : undefined;

          // Check if location differs
          const lineDiffers = actualLineUser !== lineNumber;
          const columnDiffers = columnNumber !== undefined && actualColumnUser !== columnNumber;
          const locationDiffers = lineDiffers || columnDiffers;

          // Wait for the breakpoint to potentially be hit (configurable timeout)
          await new Promise(resolve => setTimeout(resolve, timeout));

          // Check if we're paused at the breakpoint
          if (!cdpManager.isPaused()) {
            // Remove temp breakpoint
            await cdpManager.removeBreakpoint(tempBreakpoint.breakpointId);

            const response: any = {
              valid: 'unknown',
              message: 'Unable to validate - code at this location has not been executed yet',
              suggestion: 'Trigger the code path that contains this line, or set the logpoint and check console for errors',
              expressions,
              logMessage,
              location: {
                requested: { line: lineNumber, column: columnNumber },
                actual: { line: actualLineUser, column: actualColumnUser },
                matched: !locationDiffers
              }
            };

            if (locationDiffers) {
              response.warning = `CDP mapped your requested location ${lineNumber}:${columnNumber || 'auto'} to ${actualLineUser}:${actualColumnUser || 'auto'}`;
            }

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(response, null, 2),
                },
              ],
            };
          }

          // Try to evaluate each expression and collect available variables
          const results: Array<{ expression: string; valid: boolean; value?: any; error?: string }> = [];
          let availableVariables: string[] = [];

          const callFrame = cdpManager.getCallStack()?.[0];
          if (callFrame) {
            // Get available variables at this location
            try {
              const vars = await cdpManager.getVariables(callFrame.callFrameId, false);
              availableVariables = vars.map((v: any) => v.name);
            } catch (err) {
              // Ignore errors getting variables
            }

            // Evaluate each expression
            for (const expr of expressions) {
              try {
                const value = await cdpManager.evaluateExpression(expr, callFrame.callFrameId);
                results.push({
                  expression: expr,
                  valid: true,
                  value,
                });
              } catch (error) {
                results.push({
                  expression: expr,
                  valid: false,
                  error: String(error),
                });
              }
            }
          } else {
            // No call frame available
            for (const expr of expressions) {
              results.push({
                expression: expr,
                valid: false,
                error: 'No call frame available',
              });
            }
          }

          // Resume execution
          await cdpManager.resume();

          // Remove temp breakpoint
          await cdpManager.removeBreakpoint(tempBreakpoint.breakpointId);

          const allValid = results.every(r => r.valid);
          const invalidExpressions = results.filter(r => !r.valid);

          // Get code snippet (3 lines context around actual location)
          let codeContext: string | undefined;
          try {
            const startLine = Math.max(1, actualLineUser - 1);
            const endLine = actualLineUser + 1;
            const sourceResult = await cdpManager.getSourceCode(url, startLine, endLine);
            codeContext = sourceResult.code;
          } catch (err) {
            // Ignore errors getting code snippet
          }

          // Build response
          const response: any = {
            valid: allValid,
            message: allValid
              ? 'All expressions are valid at this location'
              : `${invalidExpressions.length} expression(s) failed to evaluate`,
            location: {
              requested: { line: lineNumber, column: columnNumber },
              actual: { line: actualLineUser, column: actualColumnUser },
              matched: !locationDiffers
            },
            results,
            availableVariables: availableVariables.length > 0 ? availableVariables : undefined,
            codeContext,
          };

          if (locationDiffers) {
            response.warning = `CDP mapped your requested location ${lineNumber}:${columnNumber || 'auto'} to ${actualLineUser}:${actualColumnUser || 'auto'}`;
          }

          // If validation failed, search for better locations
          if (!allValid) {
            try {
              const suggestions = await cdpManager.findBestLogpointLocation(
                url,
                lineNumber,
                columnNumber,
                expressions,
                2,  // searchRadius ±2 lines
                1000  // 1 second timeout per candidate
              );

              if (suggestions.length > 0) {
                response.suggestions = suggestions.slice(0, 3);  // Top 3 suggestions
                response.suggestion = `Consider using one of the suggested locations where ${suggestions[0].score}% of expressions are valid`;
              } else {
                response.suggestion = 'Check variable names and scopes. Variables must be in scope at the logpoint location.';
              }
            } catch (err) {
              response.suggestion = 'Check variable names and scopes. Variables must be in scope at the logpoint location.';
            }
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(response, null, 2),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  valid: false,
                  error: `Validation failed: ${error}`,
                  message: 'Could not validate logpoint expression',
                }, null, 2),
              },
            ],
          };
        }
      }
    ),

    setLogpoint: createTool(
      'Set a logpoint that logs without pausing execution (like Chrome DevTools Logpoints)',
      setLogpointSchema,
      async (args) => {
        const { url, lineNumber, columnNumber, logMessage, condition, includeCallStack, includeVariables } = args;

        // Try to map through source maps if this is a TypeScript file
        let targetUrl = url;
        let targetLine = lineNumber;
        let targetColumn = columnNumber;

        if (url.endsWith('.ts')) {
          const mapped = await sourceMapHandler.mapToGenerated(url, lineNumber, columnNumber || 0);
          if (mapped) {
            targetUrl = mapped.generatedFile;
            targetLine = mapped.line;
            targetColumn = mapped.column;
          }
        }

        // Parse logMessage to extract expressions in {}
        const expressionMatches = logMessage.matchAll(/\{([^}]+)\}/g);
        const expressions: string[] = [];
        for (const match of expressionMatches) {
          expressions.push(match[1]);
        }

        // Build the log expression
        let logExpression = `
          (function() {
            try {
              // Evaluate expressions
              const values = {
                ${expressions.map(expr => `'${expr}': ${expr}`).join(',\n                ')}
              };

              // Helper to safely stringify values (handles objects, arrays, circular refs)
              const safeStringify = (value) => {
                if (value === null) return 'null';
                if (value === undefined) return 'undefined';
                if (typeof value === 'string') return value;
                if (typeof value === 'number' || typeof value === 'boolean') return String(value);

                // Try JSON.stringify for objects/arrays
                try {
                  return JSON.stringify(value, null, 2);
                } catch (e) {
                  // Fall back to String() for circular refs or other errors
                  return String(value);
                }
              };

              // Build log message
              let message = '${logMessage}';
              ${expressions.map(expr => `message = message.replace('{${expr}}', safeStringify(values['${expr}']));`).join('\n              ')}

              // Log to console
              console.log('[Logpoint] ${targetUrl}:${targetLine}:${targetColumn || 'auto'}:', message);

              ${includeCallStack ? `
              // Add call stack
              const stack = new Error().stack.split('\\n').slice(2, 5).join('\\n');
              console.log('  Call stack:', stack);
              ` : ''}

              ${includeVariables ? `
              // Add local variables (limited to what's in scope)
              console.log('  Variables:', values);
              ` : ''}

            } catch(e) {
              console.error('[Logpoint] Error at ${targetUrl}:${targetLine}:${targetColumn || 'auto'}:', e.message);
              console.error('[Logpoint] Note: CDP may have mapped your requested location to a different line:column');
              console.error('[Logpoint] Actual location may differ from requested. Variables scope depends on actual location.');
              console.error('[Logpoint] Use validateLogpoint to check expressions before setting logpoints.');
            }
            return false; // Never pause
          })()
        `;

        // If condition is provided, wrap it
        if (condition) {
          logExpression = `(${condition}) && ${logExpression}`;
        }

        // IMPORTANT: CDP expects 0-based line and column numbers, but we have 1-based numbers
        // Convert before calling CDP API
        const cdpLineNumber = targetLine - 1;  // Convert 1-based → 0-based
        const cdpColumnNumber = targetColumn && targetColumn > 0 ? targetColumn - 1 : undefined;  // Convert 1-based → 0-based

        // Set breakpoint with condition that logs and returns false
        const { Debugger} = (cdpManager as any).client;
        const result = await Debugger.setBreakpointByUrl({
          url: targetUrl,
          lineNumber: cdpLineNumber,  // Use 0-based CDP line number
          columnNumber: cdpColumnNumber,  // Use 0-based CDP column number (if provided)
          condition: logExpression,
        });

        // Check if breakpoint was resolved to any location
        if (!result.locations || result.locations.length === 0) {
          // Diagnose exact cause
          const diagnosis = await cdpManager.diagnoseBreakpointFailure(targetUrl, targetLine);

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: diagnosis.message,
                cause: diagnosis.cause,
                details: {
                  requestedFile: url,
                  requestedLine: lineNumber,
                  targetFile: targetUrl,
                  targetLine: targetLine,
                  totalLines: diagnosis.totalLines
                },
                suggestion: diagnosis.suggestion
              }, null, 2)
            }],
            isError: true
          };
        }

        // Warn if multiple locations (rare but possible)
        if (result.locations.length > 1) {
          console.error(`[llm-cdp] Warning: Logpoint matched ${result.locations.length} locations. Using first match.`);
        }

        // AUTOMATIC LINE/COLUMN MAPPING VALIDATION
        // Get actual location from CDP (0-based)
        const actualCdpLine = result.locations[0].lineNumber;
        const actualCdpColumn = result.locations[0].columnNumber;

        // Convert to 1-based for comparison with user input
        const actualLineUser = actualCdpLine + 1;
        const actualColumnUser = actualCdpColumn !== undefined ? actualCdpColumn + 1 : undefined;

        // Check if location differs from what user requested
        const lineDiffers = actualLineUser !== targetLine;
        const columnDiffers = targetColumn !== undefined && actualColumnUser !== targetColumn;
        const locationDiffers = lineDiffers || columnDiffers;

        // If location differs AND we have expressions to validate
        if (locationDiffers && expressions.length > 0) {
          // Validate expressions at actual location
          const validation = await cdpManager.validateLogpointAtActualLocation(
            targetUrl,
            actualLineUser,  // 1-based
            actualColumnUser, // 1-based
            expressions,
            2000  // 2 second timeout
          );

          // If validation failed (expressions not valid at actual location)
          if (!validation.allValid) {
            // Remove the breakpoint - don't keep a broken logpoint
            await cdpManager.removeBreakpoint(result.breakpointId);

            // Get code snippet at actual location (3 lines context)
            let codeContext = '';
            try {
              const sourceCode = await cdpManager.getSourceCode(
                targetUrl,
                Math.max(1, actualLineUser - 1),  // 1 line before
                actualLineUser + 1  // 1 line after
              );
              codeContext = sourceCode.code;
            } catch (e) {
              codeContext = '(Could not fetch source code)';
            }

            // Search for better locations
            let suggestions: any[] = [];
            try {
              suggestions = await cdpManager.findBestLogpointLocation(
                targetUrl,
                lineNumber,
                columnNumber,
                expressions,
                2,  // Search ±2 lines
                1000  // 1 second timeout per candidate
              );
            } catch (e) {
              // If search fails, provide a simple suggestion
              suggestions = [{
                line: actualLineUser - 1,
                reason: 'Try the line before where variables might be in scope',
                note: 'Use validateLogpoint first to test expressions'
              }];
            }

            // Return detailed error response
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: 'Logpoint expressions failed validation at actual CDP location',
                  requested: {
                    line: lineNumber,  // Original user request (1-based)
                    column: columnNumber,
                    url
                  },
                  actual: {
                    line: actualLineUser,  // Where CDP actually set it (1-based)
                    column: actualColumnUser,
                    lineOffset: actualLineUser - lineNumber,
                    columnOffset: actualColumnUser && columnNumber ? actualColumnUser - columnNumber : null,
                    reason: 'V8 mapped to nearest valid breakpoint location'
                  },
                  validation: {
                    failedExpressions: validation.results.filter(r => !r.valid).map(r => r.expression),
                    results: validation.results,
                  },
                  codeContext: {
                    actualLocation: codeContext,
                    availableVariables: validation.availableVariables || []
                  },
                  suggestions: suggestions.length > 0 ? suggestions : undefined,
                  helpMessage: suggestions.length > 0 && suggestions[0].score === 100
                    ? `Set logpoint at line ${suggestions[0].line}:${suggestions[0].column || 'auto'} instead where all expressions are in scope.`
                    : `Variables not in scope at actual location ${actualLineUser}:${actualColumnUser || 'auto'}. Try using validateLogpoint to find a better location.`
                }, null, 2)
              }]
            };
          }

          // Validation passed but location differs - will show warning in success response below
        }

        // Store as logpoint in breakpoint map
        const breakpointInfo: any = {
          breakpointId: result.breakpointId,
          location: result.locations[0],
          isLogpoint: true,
          originalLocation: url !== targetUrl ? { url, lineNumber, columnNumber } : undefined,
        };
        (cdpManager as any).state.breakpoints.set(result.breakpointId, breakpointInfo);

        // Inject console notification
        await cdpManager.injectConsoleLink(targetUrl, targetLine, '📝 Logpoint set at');

        // Parse expressions to include in the response
        const expressionMatchesForResponse = logMessage.matchAll(/\{([^}]+)\}/g);
        const expressionsForResponse: string[] = [];
        for (const match of expressionMatchesForResponse) {
          expressionsForResponse.push(match[1]);
        }

        // Build response based on whether location differs
        const responseData: any = {
          success: true,
          breakpointId: result.breakpointId,
          location: {
            requested: { line: lineNumber, column: columnNumber },
            actual: { line: actualLineUser, column: actualColumnUser },
            matched: !locationDiffers
          },
          logMessage,
          expressions: expressionsForResponse,
          condition: condition || 'none',
          note: 'This logpoint will log to the browser console without pausing execution',
        };

        // If location differs, add warning and validation info
        if (locationDiffers && expressions.length > 0) {
          responseData.warning = `Logpoint was set at line ${actualLineUser}:${actualColumnUser || 'auto'} (not ${lineNumber}:${columnNumber || 'auto'}) due to V8 line mapping. All expressions validated successfully at this location.`;
          responseData.message = `Logpoint set at ${targetUrl}:${actualLineUser}:${actualColumnUser || 'auto'} (requested ${lineNumber}:${columnNumber || 'auto'})`;
        } else {
          responseData.message = `Logpoint set at ${targetUrl}:${targetLine}:${targetColumn || 'auto'}`;
          if (expressionsForResponse.length > 0) {
            responseData.tip = 'If you see console errors about undefined variables, use validateLogpoint to check expression validity';
          }
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(responseData, null, 2),
            },
          ],
        };
      }
    ),
  };
}
