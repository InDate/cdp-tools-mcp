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
  logMessage: z.string().describe('Message to log. Use {expression} for variable interpolation, e.g., "User: {user.name} ID: {user.id}"'),
  condition: z.string().optional().describe('Optional condition - only log when this evaluates to true'),
  includeCallStack: z.boolean().default(false).describe('Include call stack in log output (default: false)'),
  includeVariables: z.boolean().default(false).describe('Include local variables in log output (default: false)'),
}).strict();

const validateLogpointSchema = z.object({
  url: z.string().describe('The file URL or path'),
  lineNumber: z.number().describe('The line number (1-based)'),
  logMessage: z.string().describe('Message to log with {expression} interpolation'),
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
        const { url, lineNumber, logMessage } = args;

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
          const tempBreakpoint = await cdpManager.setBreakpoint(url, lineNumber);

          // Wait briefly for the breakpoint to potentially be hit
          await new Promise(resolve => setTimeout(resolve, 1000));

          // Check if we're paused at the breakpoint
          if (!cdpManager.isPaused()) {
            // Remove temp breakpoint
            await cdpManager.removeBreakpoint(tempBreakpoint.breakpointId);

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    valid: 'unknown',
                    message: 'Unable to validate - code at this location has not been executed yet',
                    suggestion: 'Trigger the code path that contains this line, or set the logpoint and check console for errors',
                    expressions,
                    logMessage,
                  }, null, 2),
                },
              ],
            };
          }

          // Try to evaluate each expression
          const results: Array<{ expression: string; valid: boolean; value?: any; error?: string }> = [];

          for (const expr of expressions) {
            try {
              const callFrame = cdpManager.getCallStack()?.[0];
              if (!callFrame) {
                results.push({
                  expression: expr,
                  valid: false,
                  error: 'No call frame available',
                });
                continue;
              }

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

          // Resume execution
          await cdpManager.resume();

          // Remove temp breakpoint
          await cdpManager.removeBreakpoint(tempBreakpoint.breakpointId);

          const allValid = results.every(r => r.valid);
          const invalidExpressions = results.filter(r => !r.valid);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  valid: allValid,
                  message: allValid
                    ? 'All expressions are valid at this location'
                    : `${invalidExpressions.length} expression(s) failed to evaluate`,
                  results,
                  suggestion: allValid ? undefined : 'Check variable names and scopes. Variables must be in scope at the logpoint location.',
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
        const { url, lineNumber, logMessage, condition, includeCallStack, includeVariables } = args;

        // Try to map through source maps if this is a TypeScript file
        let targetUrl = url;
        let targetLine = lineNumber;

        if (url.endsWith('.ts')) {
          const mapped = await sourceMapHandler.mapToGenerated(url, lineNumber, 0);
          if (mapped) {
            targetUrl = mapped.generatedFile;
            targetLine = mapped.line;
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

              // Build log message
              let message = '${logMessage}';
              ${expressions.map(expr => `message = message.replace('{${expr}}', String(values['${expr}']));`).join('\n              ')}

              // Log to console
              console.log('[Logpoint] ${targetUrl}:${targetLine}:', message);

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
              console.error('[Logpoint] Error at ${targetUrl}:${targetLine}:', e.message);
              console.error('[Logpoint] Tip: Check that all variables in the logpoint are in scope at this location.');
              console.error('[Logpoint] Use validateLogpoint tool to test expressions before setting logpoints.');
            }
            return false; // Never pause
          })()
        `;

        // If condition is provided, wrap it
        if (condition) {
          logExpression = `(${condition}) && ${logExpression}`;
        }

        // Set breakpoint with condition that logs and returns false
        const { Debugger } = (cdpManager as any).client;
        const result = await Debugger.setBreakpointByUrl({
          url: targetUrl,
          lineNumber: targetLine,
          condition: logExpression,
        });

        // Store as logpoint in breakpoint map
        const breakpointInfo: any = {
          breakpointId: result.breakpointId,
          location: result.locations[0],
          isLogpoint: true,
          originalLocation: url !== targetUrl ? { url, lineNumber, columnNumber: 0 } : undefined,
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

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                breakpointId: result.breakpointId,
                location: result.locations[0],
                logMessage,
                expressions: expressionsForResponse,
                condition: condition || 'none',
                message: `Logpoint set at ${targetUrl}:${targetLine}`,
                note: 'This logpoint will log to the browser console without pausing execution',
                tip: expressionsForResponse.length > 0 ? 'If you see console errors about undefined variables, use validateLogpoint to check expression validity' : undefined,
              }, null, 2),
            },
          ],
        };
      }
    ),
  };
}
