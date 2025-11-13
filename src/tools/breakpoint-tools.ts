/**
 * Breakpoint Management Tools
 */

import { z } from 'zod';
import { CDPManager } from '../cdp-manager.js';
import { SourceMapHandler } from '../sourcemap-handler.js';
import { createTool } from '../validation-helpers.js';
import type { LogpointExecutionTracker } from '../logpoint-execution-tracker.js';
import { createSuccessResponse, createErrorResponse, getErrorMessage } from '../messages.js';

// Schema definitions
const setBreakpointSchema = z.object({
  url: z.string().describe('The file URL or path (e.g., file:///path/to/file.js or http://localhost:3000/app.js)'),
  lineNumber: z.number().describe('The line number (1-based)'),
  columnNumber: z.number().optional().describe('The column number (optional, 0-based)'),
  condition: z.string().optional().describe('Optional condition expression - breakpoint only triggers when this evaluates to true'),
  connectionReason: z.string().optional().describe('Brief reason for needing this browser connection (3 descriptive words recommended). Auto-creates/reuses tabs. Only needed for browser debugging, not Node.js.'),
}).strict();

const removeBreakpointSchema = z.object({
  breakpointId: z.string().describe('The breakpoint ID to remove'),
  connectionReason: z.string().optional().describe('Brief reason for needing this browser connection (3 descriptive words recommended). Auto-creates/reuses tabs. Only needed for browser debugging, not Node.js.'),
}).strict();

const listBreakpointsSchema = z.object({
  connectionReason: z.string().optional().describe('Brief reason for needing this browser connection (3 descriptive words recommended). Auto-creates/reuses tabs. Only needed for browser debugging, not Node.js.'),
}).strict();

const resetLogpointCounterSchema = z.object({
  breakpointId: z.string().describe('The logpoint breakpoint ID to reset'),
  connectionReason: z.string().optional().describe('Brief reason for needing this browser connection (3 descriptive words recommended). Auto-creates/reuses tabs. Only needed for browser debugging, not Node.js.'),
}).strict();

const setLogpointSchema = z.object({
  url: z.string().describe('The file URL or path'),
  lineNumber: z.number().describe('The line number (1-based)'),
  columnNumber: z.number().optional().describe('Optional column number (1-based). If not provided, CDP will choose the best execution point on the line.'),
  logMessage: z.string().describe('Message to log. Use {expression} for variable interpolation, e.g., "User: {user.name} ID: {user.id}"'),
  condition: z.string().optional().describe('Optional condition - only log when this evaluates to true'),
  includeCallStack: z.boolean().default(false).describe('Include call stack in log output (default: false)'),
  includeVariables: z.boolean().default(false).describe('Include local variables in log output (default: false)'),
  maxExecutions: z.number().int().min(1).default(20).describe('Maximum number of times this logpoint can execute before pausing (default: 20, minimum: 1). When the limit is reached, execution will pause and show captured logs with options to reset or remove the logpoint. Unlimited execution is not allowed.'),
  connectionReason: z.string().optional().describe('Brief reason for needing this browser connection (3 descriptive words recommended). Auto-creates/reuses tabs. Only needed for browser debugging, not Node.js.'),
}).strict();

const validateLogpointSchema = z.object({
  url: z.string().describe('The file URL or path'),
  lineNumber: z.number().describe('The line number (1-based)'),
  columnNumber: z.number().optional().describe('Optional column number (1-based). If not provided, CDP will choose the execution point.'),
  logMessage: z.string().describe('Message to log with {expression} interpolation'),
  timeout: z.number().default(2000).describe('Maximum time to wait for code execution in milliseconds (default: 2000ms)'),
  connectionReason: z.string().optional().describe('Brief reason for needing this browser connection (3 descriptive words recommended). Auto-creates/reuses tabs. Only needed for browser debugging, not Node.js.'),
}).strict();

export function createBreakpointTools(
  cdpManager: CDPManager,
  sourceMapHandler: SourceMapHandler,
  logpointTracker?: LogpointExecutionTracker,
  resolveConnectionFromReason?: (connectionReason: string) => Promise<{
    connection: any;
    cdpManager: CDPManager;
    puppeteerManager: any;
    consoleMonitor: any;
    networkMonitor: any;
  } | null>
) {
  return {
    setBreakpoint: createTool(
      'Set a breakpoint at a specific file and line number. Supports conditional breakpoints that only pause when a condition is true.',
      setBreakpointSchema,
      async (args) => {
        const { url, lineNumber, columnNumber, connectionReason } = args;

        // Resolve connection if connectionReason is provided
        let targetCdpManager = cdpManager;
        if (connectionReason && resolveConnectionFromReason) {
          const resolved = await resolveConnectionFromReason(connectionReason);
          if (!resolved) {
            return createErrorResponse('DEBUGGER_NOT_CONNECTED');
          }
          targetCdpManager = resolved.cdpManager;
        }

        // Check connection and runtime type
        const runtimeType = targetCdpManager.getRuntimeType();
        const isConnected = targetCdpManager.isConnected();

        if (!isConnected) {
          return createErrorResponse('DEBUGGER_NOT_CONNECTED');
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
          const breakpoint = await targetCdpManager.setBreakpoint(targetUrl, targetLine, targetColumn, args.condition);

          // Inject clickable console link
          const icon = args.condition ? '🔶' : '🔴';
          const label = args.condition ? 'Conditional breakpoint set at' : 'Breakpoint set at';
          await targetCdpManager.injectConsoleLink(targetUrl, targetLine, `${icon} ${label}`);

          // Return markdown-only success response
          return createSuccessResponse('BREAKPOINT_SET_SUCCESS', {
            url: targetUrl,
            lineNumber: targetLine,
            breakpointId: breakpoint.breakpointId,
            condition: args.condition,
          });
        } catch (error: any) {
          // Build context-aware error message
          let markdown = getErrorMessage('BREAKPOINT_SET_FAILED', {
            url: targetUrl,
            lineNumber: targetLine,
            error: error.message,
          });

          // Add runtime-specific TIP if applicable
          if (runtimeType === 'chrome' && (url.includes('/dist/') || url.includes('index.js'))) {
            markdown += '\n\n**TIP:** You are connected to Chrome (browser) but trying to set a breakpoint on what looks like server code. ' +
                        'If this is Node.js server code, you need to connect to the Node.js debugger separately using `connectDebugger({port: 9229})`.';
          } else if (runtimeType === 'node' && url.includes('/public/')) {
            markdown += '\n\n**TIP:** You are connected to Node.js but trying to set a breakpoint on what looks like browser code. ' +
                        'You may need to connect to Chrome using `connectDebugger({port: 9222})` for client-side debugging.';
          }

          return {
            content: [
              {
                type: 'text',
                text: markdown,
              },
            ],
            isError: true,
          };
        }
      }
    ),

    removeBreakpoint: createTool(
      'Remove a specific breakpoint by its ID',
      removeBreakpointSchema,
      async (args) => {
        const { breakpointId, connectionReason } = args;

        // Resolve connection if connectionReason is provided
        let targetCdpManager = cdpManager;
        if (connectionReason && resolveConnectionFromReason) {
          const resolved = await resolveConnectionFromReason(connectionReason);
          if (!resolved) {
            return createErrorResponse('DEBUGGER_NOT_CONNECTED');
          }
          targetCdpManager = resolved.cdpManager;
        }

        // Unregister from logpoint tracker if it's a logpoint
        if (logpointTracker) {
          logpointTracker.unregisterLogpoint(breakpointId);
        }

        await targetCdpManager.removeBreakpoint(breakpointId);

        return createSuccessResponse('BREAKPOINT_REMOVE_SUCCESS', { breakpointId });
      }
    ),

    listBreakpoints: createTool(
      'List all active breakpoints',
      listBreakpointsSchema,
      async (args) => {
        const { connectionReason } = args;

        // Resolve connection if connectionReason is provided
        let targetCdpManager = cdpManager;
        if (connectionReason && resolveConnectionFromReason) {
          const resolved = await resolveConnectionFromReason(connectionReason);
          if (!resolved) {
            return createErrorResponse('DEBUGGER_NOT_CONNECTED');
          }
          targetCdpManager = resolved.cdpManager;
        }
        const breakpoints = targetCdpManager.getBreakpoints();
        const counts = targetCdpManager.getBreakpointCounts();

        // Build markdown response
        let markdown = `## Active Breakpoints\n\n`;
        markdown += `**Total:** ${counts.total} (${counts.breakpoints} breakpoint${counts.breakpoints !== 1 ? 's' : ''}, ${counts.logpoints} logpoint${counts.logpoints !== 1 ? 's' : ''})\n\n`;

        if (breakpoints.length === 0) {
          markdown += 'No active breakpoints.\n\n';
          markdown += '**TIP:** Use `setBreakpoint()` to set a breakpoint or `setLogpoint()` to set a logpoint.';
        } else {
          markdown += '| ID | Type | Location |\n';
          markdown += '|---|---|---|\n';

          breakpoints.forEach(bp => {
            const type = bp.isLogpoint ? 'logpoint' : 'breakpoint';
            let location: string;
            if (bp.originalLocation) {
              location = `${bp.originalLocation.url}:${bp.originalLocation.lineNumber}${bp.originalLocation.columnNumber !== undefined ? `:${bp.originalLocation.columnNumber}` : ''}`;
            } else {
              // Fall back to scriptId-based location (CDP internal)
              location = `scriptId:${bp.location.scriptId}:${bp.location.lineNumber + 1}${bp.location.columnNumber !== undefined ? `:${bp.location.columnNumber + 1}` : ''}`;
            }
            markdown += `| \`${bp.breakpointId}\` | ${type} | \`${location}\` |\n`;
          });
        }

        return {
          content: [
            {
              type: 'text',
              text: markdown,
            },
          ],
        };
      }
    ),

    resetLogpointCounter: createTool(
      'Reset the execution counter for a logpoint, allowing it to execute another maxExecutions times. Use this after a logpoint has reached its limit and you want to continue collecting more logs.',
      resetLogpointCounterSchema,
      async (args) => {
        const { breakpointId, connectionReason } = args;

        // Resolve connection if connectionReason is provided
        let targetCdpManager = cdpManager;
        if (connectionReason && resolveConnectionFromReason) {
          const resolved = await resolveConnectionFromReason(connectionReason);
          if (!resolved) {
            return createErrorResponse('DEBUGGER_NOT_CONNECTED');
          }
          targetCdpManager = resolved.cdpManager;
        }

        // Reset the counter in the tracker
        if (!logpointTracker) {
          return createErrorResponse('DEBUGGER_NOT_CONNECTED');
        }

        const metadata = logpointTracker.getLogpoint(breakpointId);

        if (!metadata) {
          return createErrorResponse('BREAKPOINT_NOT_FOUND', { breakpointId });
        }

        // Reset the counter in the tracker
        const previousCount = metadata.executionCount;
        logpointTracker.resetCounter(breakpointId);

        // Reset the global counter in the page context
        const logpointKey = `${metadata.url}:${metadata.lineNumber}`;
        try {
          await targetCdpManager.evaluateExpression(`
            if (typeof globalThis.__llmCdpLogpointCounters !== 'undefined') {
              globalThis.__llmCdpLogpointCounters['${logpointKey.replace(/'/g, "\\'")}'] = 0;
            }
          `);
        } catch (error) {
          // Ignore errors - counter may not exist yet
        }

        // Clear the logpoint limit exceeded state in CDPManager
        targetCdpManager.clearLogpointLimitExceeded();

        // Build markdown response with details
        let markdown = getErrorMessage('LOGPOINT_COUNTER_RESET', {
          breakpointId,
          maxExecutions: metadata.maxExecutions,
        });

        markdown += `\n\n**Logpoint Details:**\n`;
        markdown += `- **Location:** \`${metadata.url}:${metadata.lineNumber}\`\n`;
        markdown += `- **Log Message:** \`${metadata.logMessage}\`\n`;
        markdown += `- **Previous Count:** ${previousCount}\n`;
        markdown += `- **New Count:** 0\n`;
        markdown += `\n**Next Step:** Use \`resume()\` to continue execution.`;

        return {
          content: [
            {
              type: 'text',
              text: markdown,
            },
          ],
        };
      }
    ),

    validateLogpoint: createTool(
      'Validate a logpoint expression before setting it. Tests if the expressions in the log message can be evaluated and provides helpful feedback.',
      validateLogpointSchema,
      async (args) => {
        const { url, lineNumber, columnNumber, logMessage, timeout, connectionReason } = args;

        // Resolve connection if connectionReason is provided
        let targetCdpManager = cdpManager;
        if (connectionReason && resolveConnectionFromReason) {
          const resolved = await resolveConnectionFromReason(connectionReason);
          if (!resolved) {
            return createErrorResponse('DEBUGGER_NOT_CONNECTED');
          }
          targetCdpManager = resolved.cdpManager;
        }

        // Parse logMessage to extract expressions
        const expressionMatches = logMessage.matchAll(/\{([^}]+)\}/g);
        const expressions: string[] = [];
        for (const match of expressionMatches) {
          expressions.push(match[1]);
        }

        if (expressions.length === 0) {
          const markdown = `## Logpoint Validation\n\n` +
            `**Status:** Valid\n` +
            `**Message:** No expressions to validate in log message\n` +
            `**Log Message:** \`${logMessage}\`\n\n` +
            `**Note:** This log message contains no variable interpolations. It will output as-is.`;

          return {
            content: [
              {
                type: 'text',
                text: markdown,
              },
            ],
          };
        }

        // Set a temporary breakpoint to test the expressions
        try {
          const tempBreakpoint = await targetCdpManager.setBreakpoint(url, lineNumber, columnNumber);

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
          if (!targetCdpManager.isPaused()) {
            // Remove temp breakpoint
            await targetCdpManager.removeBreakpoint(tempBreakpoint.breakpointId);

            let markdown = `## Logpoint Validation\n\n`;
            markdown += `**Status:** Unknown\n`;
            markdown += `**Message:** Unable to validate - code at this location has not been executed yet\n\n`;
            markdown += `**Expressions:** ${expressions.map(e => `\`${e}\``).join(', ')}\n`;
            markdown += `**Log Message:** \`${logMessage}\`\n\n`;
            markdown += `**Location:**\n`;
            markdown += `- **Requested:** Line ${lineNumber}${columnNumber ? `:${columnNumber}` : ''}\n`;
            markdown += `- **Actual:** Line ${actualLineUser}${actualColumnUser ? `:${actualColumnUser}` : ''}\n`;
            markdown += `- **Matched:** ${!locationDiffers ? 'Yes' : 'No'}\n\n`;

            if (locationDiffers) {
              markdown += `**Warning:** CDP mapped your requested location ${lineNumber}:${columnNumber || 'auto'} to ${actualLineUser}:${actualColumnUser || 'auto'}\n\n`;
            }

            markdown += `**Suggestion:** Trigger the code path that contains this line, or set the logpoint and check console for errors`;

            return {
              content: [
                {
                  type: 'text',
                  text: markdown,
                },
              ],
            };
          }

          // Try to evaluate each expression and collect available variables
          const results: Array<{ expression: string; valid: boolean; value?: any; error?: string }> = [];
          let availableVariables: string[] = [];

          const callFrame = targetCdpManager.getCallStack()?.[0];
          if (callFrame) {
            // Get available variables at this location
            try {
              const vars = await targetCdpManager.getVariables(callFrame.callFrameId, false);
              availableVariables = vars.map((v: any) => v.name);
            } catch (err) {
              // Ignore errors getting variables
            }

            // Evaluate each expression
            for (const expr of expressions) {
              try {
                const value = await targetCdpManager.evaluateExpression(expr, callFrame.callFrameId);
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
          await targetCdpManager.resume();

          // Remove temp breakpoint
          await targetCdpManager.removeBreakpoint(tempBreakpoint.breakpointId);

          const allValid = results.every(r => r.valid);
          const invalidExpressions = results.filter(r => !r.valid);

          // Get code snippet (3 lines context around actual location)
          let codeContext: string | undefined;
          try {
            const startLine = Math.max(1, actualLineUser - 1);
            const endLine = actualLineUser + 1;
            const sourceResult = await targetCdpManager.getSourceCode(url, startLine, endLine);
            codeContext = sourceResult.code;
          } catch (err) {
            // Ignore errors getting code snippet
          }

          // Build markdown response
          let markdown = `## Logpoint Validation\n\n`;
          markdown += `**Status:** ${allValid ? 'Valid ✓' : 'Failed ✗'}\n`;
          markdown += `**Message:** ${allValid ? 'All expressions are valid at this location' : `${invalidExpressions.length} expression(s) failed to evaluate`}\n\n`;

          // Location info
          markdown += `**Location:**\n`;
          markdown += `- **Requested:** Line ${lineNumber}${columnNumber ? `:${columnNumber}` : ''}\n`;
          markdown += `- **Actual:** Line ${actualLineUser}${actualColumnUser ? `:${actualColumnUser}` : ''}\n`;
          markdown += `- **Matched:** ${!locationDiffers ? 'Yes' : 'No'}\n\n`;

          if (locationDiffers) {
            markdown += `**Warning:** CDP mapped your requested location ${lineNumber}:${columnNumber || 'auto'} to ${actualLineUser}:${actualColumnUser || 'auto'}\n\n`;
          }

          // Expression results
          markdown += `**Expression Results:**\n\n`;
          markdown += `| Expression | Valid | Value/Error |\n`;
          markdown += `|---|---|---|\n`;
          results.forEach(r => {
            const status = r.valid ? '✓' : '✗';
            const valueStr = r.valid ? JSON.stringify(r.value) : r.error;
            markdown += `| \`${r.expression}\` | ${status} | ${valueStr} |\n`;
          });
          markdown += `\n`;

          // Available variables
          if (availableVariables.length > 0) {
            markdown += `**Available Variables:** ${availableVariables.map(v => `\`${v}\``).join(', ')}\n\n`;
          }

          // Code context
          if (codeContext) {
            markdown += `**Code Context:**\n\`\`\`javascript\n${codeContext}\n\`\`\`\n\n`;
          }

          // If validation failed, search for better locations
          if (!allValid) {
            try {
              const suggestions = await targetCdpManager.findBestLogpointLocation(
                url,
                lineNumber,
                columnNumber,
                expressions,
                2,  // searchRadius ±2 lines
                1000  // 1 second timeout per candidate
              );

              if (suggestions.length > 0) {
                markdown += `**Suggestions:**\n`;
                suggestions.slice(0, 3).forEach((s: any) => {
                  markdown += `- Line ${s.line}${s.column ? `:${s.column}` : ''} - ${s.score}% of expressions valid\n`;
                });
                markdown += `\n**Recommendation:** Consider using line ${suggestions[0].line} where ${suggestions[0].score}% of expressions are valid`;
              } else {
                markdown += `**Suggestion:** Check variable names and scopes. Variables must be in scope at the logpoint location.`;
              }
            } catch (err) {
              markdown += `**Suggestion:** Check variable names and scopes. Variables must be in scope at the logpoint location.`;
            }
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
          return createErrorResponse('LOGPOINT_VALIDATE_FAILED', {
            error: String(error),
          });
        }
      }
    ),

    setLogpoint: createTool(
      'Set a logpoint that logs without pausing execution (like Chrome DevTools Logpoints). By default, logpoints are limited to 20 executions to prevent flooding logs. When a logpoint reaches its limit, execution pauses and you must either reset the counter or remove the logpoint. Use maxExecutions parameter to adjust the limit (minimum 1, no unlimited option).',
      setLogpointSchema,
      async (args) => {
        const { url, lineNumber, columnNumber, logMessage, condition, includeCallStack, includeVariables, maxExecutions, connectionReason } = args;

        // Resolve connection if connectionReason is provided
        let targetCdpManager = cdpManager;
        if (connectionReason && resolveConnectionFromReason) {
          const resolved = await resolveConnectionFromReason(connectionReason);
          if (!resolved) {
            return createErrorResponse('DEBUGGER_NOT_CONNECTED');
          }
          targetCdpManager = resolved.cdpManager;
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

        // Parse logMessage to extract expressions in {}
        const expressionMatches = logMessage.matchAll(/\{([^}]+)\}/g);
        const expressions: string[] = [];
        for (const match of expressionMatches) {
          expressions.push(match[1]);
        }

        // Build the log expression with execution limiting
        // Use a unique key for this logpoint based on location
        const logpointKey = `${targetUrl}:${targetLine}`;

        let logExpression = `
          (function() {
            try {
              // Initialize global storage if needed
              if (typeof globalThis.__llmCdpLogpointCounters === 'undefined') {
                globalThis.__llmCdpLogpointCounters = {};
              }
              if (typeof globalThis.__llmCdpLogpointErrors === 'undefined') {
                globalThis.__llmCdpLogpointErrors = [];
              }

              // Get/increment counter for this logpoint
              const key = '${logpointKey.replace(/'/g, "\\'")}';
              globalThis.__llmCdpLogpointCounters[key] = (globalThis.__llmCdpLogpointCounters[key] || 0) + 1;
              const executionCount = globalThis.__llmCdpLogpointCounters[key];

              // Check if limit exceeded
              if (executionCount > ${maxExecutions}) {
                return true; // PAUSE - limit exceeded
              }

              // Evaluate expressions safely - wrap each in try-catch to prevent one failure from breaking all
              const values = {};
              ${expressions.map(expr => {
                const escapedExpr = expr.replace(/'/g, "\\'");
                return `
              try {
                values['${escapedExpr}'] = ${expr};
              } catch (e) {
                values['${escapedExpr}'] = '[Error: ' + e.message + ']';
              }`;
              }).join('')}

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

              // Build log message (using JSON.stringify to safely escape the template)
              let message = ${JSON.stringify(logMessage)};
              ${expressions.map(expr => {
                // Escape single quotes in the expression key for safe string literal
                const escapedExpr = expr.replace(/'/g, "\\'");
                return `message = message.replace('{${expr}}', safeStringify(values['${escapedExpr}']));`;
              }).join('\n              ')}

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

              // Check if this is the last allowed execution
              if (executionCount === ${maxExecutions}) {
                console.warn('[Logpoint] Execution limit reached (${maxExecutions}/${maxExecutions}). Will pause on next execution.');
              }

            } catch(e) {
              // Store error in global array for retrieval via searchConsoleLogs
              const errorInfo = {
                type: 'logpoint-error',
                location: '${targetUrl}:${targetLine}:${targetColumn || 'auto'}',
                expressions: ${JSON.stringify(expressions)},
                error: e.message,
                stack: e.stack || e.toString(),
                timestamp: new Date().toISOString()
              };
              globalThis.__llmCdpLogpointErrors.push(errorInfo);

              // Keep only last 50 errors to prevent memory issues
              if (globalThis.__llmCdpLogpointErrors.length > 50) {
                globalThis.__llmCdpLogpointErrors.shift();
              }

              // Log error to console with warning level for visibility
              console.warn('[Logpoint Error] ' + '${targetUrl}:${targetLine}' + ': ' + e.message + ' | Expressions: ' + ${JSON.stringify(expressions)}.join(', '));
            }
            return false; // Don't pause (unless limit exceeded above)
          })()
        `;

        // If condition is provided, wrap it
        if (condition) {
          logExpression = `(${condition}) && ${logExpression}`;
        }

        // Use targetCdpManager.setBreakpoint to ensure proper state management
        // This ensures state.breakpoints Map is updated immediately
        let breakpoint: any;
        try {
          breakpoint = await targetCdpManager.setBreakpoint(
            targetUrl,
            targetLine,  // targetCdpManager.setBreakpoint expects 1-based numbers
            targetColumn,
            logExpression
          );
        } catch (error: any) {
          let markdown = `## Failed to Set Logpoint\n\n`;
          markdown += `**Error:** ${error.message}\n\n`;
          markdown += `**Details:**\n`;
          markdown += `- **Requested:** \`${url}:${lineNumber}\`\n`;
          markdown += `- **Target:** \`${targetUrl}:${targetLine}\`\n\n`;

          if (error.message.includes('not loaded')) {
            markdown += `**Suggestion:** The script has not been loaded by the runtime yet. Try navigating to the page or reloading.`;
          } else {
            markdown += `**Suggestion:** Verify the file has been loaded and the line number is valid.`;
          }

          return {
            content: [{
              type: 'text',
              text: markdown,
            }],
            isError: true
          };
        }

        // Mark as logpoint in the breakpoint info (state is already updated by setBreakpoint)
        breakpoint.isLogpoint = true;
        (cdpManager as any).state.breakpoints.set(breakpoint.breakpointId, breakpoint);

        // AUTOMATIC LINE/COLUMN MAPPING VALIDATION
        // Get actual location from CDP (0-based)
        const actualCdpLine = breakpoint.location.lineNumber;
        const actualCdpColumn = breakpoint.location.columnNumber;

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
          const validation = await targetCdpManager.validateLogpointAtActualLocation(
            targetUrl,
            actualLineUser,  // 1-based
            actualColumnUser, // 1-based
            expressions,
            2000  // 2 second timeout
          );

          // If validation failed (expressions not valid at actual location)
          if (!validation.allValid) {
            // Remove the breakpoint - don't keep a broken logpoint
            // Unregister from tracker first
            if (logpointTracker) {
              logpointTracker.unregisterLogpoint(breakpoint.breakpointId);
            }

            try {
              await targetCdpManager.removeBreakpoint(breakpoint.breakpointId);
            } catch (removeError: any) {
              // Log but continue - state might already be cleaned up
              console.error(`[llm-cdp] Warning: Failed to remove invalid logpoint: ${removeError.message}`);
            }

            // Get code snippet at actual location (3 lines context)
            let codeContext = '';
            try {
              const sourceCode = await targetCdpManager.getSourceCode(
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
              suggestions = await targetCdpManager.findBestLogpointLocation(
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
            let errorMarkdown = `## Logpoint Validation Failed\n\n`;
            errorMarkdown += `**Error:** Logpoint expressions failed validation at actual CDP location\n\n`;

            errorMarkdown += `**Requested Location:**\n`;
            errorMarkdown += `- **URL:** \`${url}\`\n`;
            errorMarkdown += `- **Line:** ${lineNumber}${columnNumber ? `:${columnNumber}` : ''}\n\n`;

            errorMarkdown += `**Actual Location (CDP Mapped):**\n`;
            errorMarkdown += `- **Line:** ${actualLineUser}${actualColumnUser ? `:${actualColumnUser}` : ''}\n`;
            errorMarkdown += `- **Offset:** ${actualLineUser - lineNumber > 0 ? '+' : ''}${actualLineUser - lineNumber} lines\n`;
            errorMarkdown += `- **Reason:** V8 mapped to nearest valid breakpoint location\n\n`;

            const failedExprs = validation.results.filter((r: any) => !r.valid).map((r: any) => r.expression);
            errorMarkdown += `**Failed Expressions:** ${failedExprs.map((e: string) => `\`${e}\``).join(', ')}\n\n`;

            errorMarkdown += `**Code Context:**\n\`\`\`javascript\n${codeContext}\n\`\`\`\n\n`;

            if (validation.availableVariables && validation.availableVariables.length > 0) {
              errorMarkdown += `**Available Variables:** ${validation.availableVariables.map((v: string) => `\`${v}\``).join(', ')}\n\n`;
            }

            if (suggestions.length > 0) {
              errorMarkdown += `**Suggestions:**\n`;
              suggestions.forEach((s: any) => {
                errorMarkdown += `- Line ${s.line}${s.column ? `:${s.column}` : ''} - ${s.score}% of expressions valid\n`;
              });
              errorMarkdown += `\n`;

              if (suggestions[0].score === 100) {
                errorMarkdown += `**Recommendation:** Set logpoint at line ${suggestions[0].line}:${suggestions[0].column || 'auto'} instead where all expressions are in scope.`;
              } else {
                errorMarkdown += `**Recommendation:** Variables not in scope at actual location ${actualLineUser}:${actualColumnUser || 'auto'}. Try using validateLogpoint to find a better location.`;
              }
            } else {
              errorMarkdown += `**Recommendation:** Variables not in scope at actual location ${actualLineUser}:${actualColumnUser || 'auto'}. Try using validateLogpoint to find a better location.`;
            }

            return {
              content: [{
                type: 'text',
                text: errorMarkdown,
              }],
              isError: true
            };
          }

          // Validation passed but location differs - will show warning in success response below
        }

        // Register with logpoint execution tracker
        if (logpointTracker) {
          logpointTracker.registerLogpoint(
            breakpoint.breakpointId,
            targetUrl,
            actualLineUser,  // Use the actual line where it was set (1-based)
            logMessage,
            maxExecutions
          );
        }

        // Inject console notification
        await targetCdpManager.injectConsoleLink(targetUrl, targetLine, '📝 Logpoint set at');

        // Parse expressions to include in the response
        const expressionMatchesForResponse = logMessage.matchAll(/\{([^}]+)\}/g);
        const expressionsForResponse: string[] = [];
        for (const match of expressionMatchesForResponse) {
          expressionsForResponse.push(match[1]);
        }

        // Build markdown success response
        let markdown = `## Logpoint Set Successfully\n\n`;
        markdown += `**Breakpoint ID:** \`${breakpoint.breakpointId}\`\n`;
        markdown += `**Location:** \`${targetUrl}:${actualLineUser}${actualColumnUser ? `:${actualColumnUser}` : ''}\`\n`;
        markdown += `**Log Message:** \`${logMessage}\`\n`;

        if (expressionsForResponse.length > 0) {
          markdown += `**Expressions:** ${expressionsForResponse.map(e => `\`${e}\``).join(', ')}\n`;
        }

        if (condition) {
          markdown += `**Condition:** \`${condition}\`\n`;
        }

        markdown += `**Max Executions:** ${maxExecutions}\n\n`;

        // If location differs, add warning and validation info
        if (locationDiffers && expressions.length > 0) {
          markdown += `**⚠️ Warning:** Logpoint was set at line ${actualLineUser}:${actualColumnUser || 'auto'} (not ${lineNumber}:${columnNumber || 'auto'}) due to V8 line mapping. All expressions validated successfully at this location.\n\n`;
        } else if (locationDiffers) {
          markdown += `**⚠️ Note:** CDP mapped your requested location ${lineNumber}:${columnNumber || 'auto'} to ${actualLineUser}:${actualColumnUser || 'auto'}\n\n`;
        }

        markdown += `**Note:** This logpoint will log to the browser console without pausing execution`;

        if (expressionsForResponse.length > 0) {
          markdown += `\n\n**TIP:** Each expression is wrapped in try-catch. If an expression fails, it will show \`[Error: message]\` in the log.`;
          markdown += `\nTo see logpoint errors, use: \`searchConsoleLogs({pattern: "Logpoint Error"})\``;
        }

        return {
          content: [
            {
              type: 'text',
              text: markdown,
            },
          ],
        };
      }
    ),
  };
}
