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
const breakpointSchema = z.object({
  action: z.enum(['set', 'remove', 'list', 'setLogpoint', 'validate', 'resetCounter', 'waitForScript']).describe('Breakpoint action: set (set breakpoint at line), remove (remove breakpoint by ID), list (list active breakpoints), setLogpoint (set logpoint with message), validate (validate logpoint expressions), resetCounter (reset logpoint counter), waitForScript (wait for script to load)'),
  connectionReason: z.string().optional().describe('Connection reference (use the reference from launchChrome output, e.g., "unnamed-connection-default" or your renamed tab)'),

  // set/setLogpoint/validate parameters
  url: z.string().optional().describe('File URL or path (for set, setLogpoint, validate, waitForScript actions)'),
  lineNumber: z.number().optional().describe('Line number (for set, setLogpoint, validate actions)'),
  columnNumber: z.number().optional().describe('Column number (for set, setLogpoint, validate actions)'),
  condition: z.string().optional().describe('Condition expression (for set, setLogpoint actions)'),

  // setLogpoint parameters
  logMessage: z.string().optional().describe('Message with {expression} interpolation (for setLogpoint, validate actions)'),
  includeCallStack: z.boolean().optional().describe('Include call stack (for setLogpoint action, default: false)'),
  includeVariables: z.boolean().optional().describe('Include local variables (for setLogpoint action, default: false)'),
  maxExecutions: z.number().int().min(1).optional().describe('Max executions before pause (for setLogpoint action, default: 20)'),

  // validate/waitForScript parameters
  timeout: z.number().optional().describe('Timeout (ms) for validate and waitForScript actions, default: 2000 for validate, 10000 for waitForScript'),

  // remove/resetCounter parameters
  breakpointId: z.string().optional().describe('Breakpoint ID (for remove, resetCounter actions)'),
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
    breakpoint: createTool(
      'Manage breakpoints and logpoints. Actions: set (set breakpoint at line), remove (remove breakpoint by ID), list (list active breakpoints), setLogpoint (set logpoint with message interpolation), validate (validate logpoint expressions), resetCounter (reset logpoint execution counter), waitForScript (wait for a script to load)',
      breakpointSchema,
      async (args) => {
        const { action } = args;

        // Resolve connection if connectionReason is provided
        let targetCdpManager = cdpManager;
        if (args.connectionReason && resolveConnectionFromReason) {
          const resolved = await resolveConnectionFromReason(args.connectionReason);
          if (!resolved) {
            return createErrorResponse('CONNECTION_NOT_FOUND');
          }
          targetCdpManager = resolved.cdpManager;
        }

        switch (action) {
          case 'set': {
            if (!args.url || args.lineNumber === undefined) {
              return createErrorResponse('INVALID_PARAMS', { message: 'url and lineNumber are required for set action' });
            }

            // Check connection and runtime type
            const runtimeType = targetCdpManager.getRuntimeType();
            const isConnected = targetCdpManager.isConnected();

            if (!isConnected) {
              return createErrorResponse('DEBUGGER_NOT_CONNECTED');
            }

            // Try to map through source maps if this is a TypeScript file
            let targetUrl = args.url;
            let targetLine = args.lineNumber;
            let targetColumn = args.columnNumber;

            if (args.url.endsWith('.ts')) {
              const mapped = await sourceMapHandler.mapToGenerated(args.url, args.lineNumber, args.columnNumber || 0);
              if (mapped) {
                targetUrl = mapped.generatedFile;
                targetLine = mapped.line;
                targetColumn = mapped.column;
              }
            }

            try {
              const breakpoint = await targetCdpManager.setBreakpoint(targetUrl, targetLine, targetColumn, args.condition);

              // Check if breakpoint is pending (script not loaded yet)
              if (breakpoint.status === 'pending') {
                // Don't inject console link for pending breakpoints (script not loaded)
                let markdown = `## Breakpoint Set (Pending)\n\n`;
                markdown += `**Breakpoint ID:** \`${breakpoint.breakpointId}\`\n`;
                markdown += `**URL:** \`${targetUrl}\`\n`;
                markdown += `**Line:** ${targetLine}\n`;
                if (args.condition) {
                  markdown += `**Condition:** \`${args.condition}\`\n`;
                }
                markdown += `\n**Status:** ⏳ Pending - Script not loaded yet\n\n`;
                markdown += `**Note:** The breakpoint has been set and will activate automatically when the script loads. `;
                markdown += `Use \`navigate({ action: 'goto' })\` or \`navigate({ action: 'reload' })\` to load the page.\n\n`;
                markdown += `**TIP:** Use \`breakpoint({ action: 'waitForScript', url: '${targetUrl}' })\` to wait for the script to load.`;

                return {
                  content: [{
                    type: 'text',
                    text: markdown,
                  }],
                };
              }

              // Get actual resolved location (CDP returns 0-based, convert to 1-based)
              const resolvedLine = breakpoint.location.lineNumber + 1;
              const resolvedColumn = breakpoint.location.columnNumber !== undefined
                ? breakpoint.location.columnNumber + 1
                : undefined;

              // Check if location was adjusted (line or column)
              // targetColumn was set earlier (line 82) and may have been modified by source mapping
              const lineAdjusted = resolvedLine !== targetLine;
              const columnAdjusted = targetColumn !== undefined && resolvedColumn !== undefined && resolvedColumn !== targetColumn;
              const wasAdjusted = lineAdjusted || columnAdjusted;

              // Inject clickable console link at resolved location
              const icon = args.condition ? '🔶' : '🔴';
              const label = args.condition ? 'Conditional breakpoint set at' : 'Breakpoint set at';
              await targetCdpManager.injectConsoleLink(targetUrl, resolvedLine, `${icon} ${label}`);

              // Build location strings for message
              const resolvedLocation = resolvedColumn !== undefined
                ? `line ${resolvedLine}:${resolvedColumn}`
                : `line ${resolvedLine}`;
              const requestedLocation = targetColumn !== undefined
                ? `line ${targetLine}:${targetColumn}`
                : `line ${targetLine}`;

              // Return markdown-only success response with resolved location info
              return createSuccessResponse('BREAKPOINT_SET_SUCCESS', {
                url: targetUrl,
                resolvedLine: resolvedLine,
                resolvedLocation: resolvedLocation,
                requestedLocation: requestedLocation,
                wasAdjusted: wasAdjusted,
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
              if (runtimeType === 'chrome' && (args.url.includes('/dist/') || args.url.includes('index.js'))) {
                markdown += '\n\n**TIP:** You are connected to Chrome (browser) but trying to set a breakpoint on what looks like server code. ' +
                            'If this is Node.js server code, you need to connect to the Node.js debugger separately using `connectDebugger({port: 9229})`.';
              } else if (runtimeType === 'node' && args.url.includes('/public/')) {
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

          case 'remove': {
            if (!args.breakpointId) {
              return createErrorResponse('INVALID_PARAMS', { message: 'breakpointId is required for remove action' });
            }

            // Unregister from logpoint tracker if it's a logpoint
            if (logpointTracker) {
              logpointTracker.unregisterLogpoint(args.breakpointId);
            }

            await targetCdpManager.removeBreakpoint(args.breakpointId);

            return createSuccessResponse('BREAKPOINT_REMOVE_SUCCESS', { breakpointId: args.breakpointId });
          }

          case 'list': {
            const breakpoints = targetCdpManager.getBreakpoints();
            const counts = targetCdpManager.getBreakpointCounts();

            // Count pending breakpoints
            const pendingCount = breakpoints.filter(bp => bp.status === 'pending').length;

            // Build markdown response
            let markdown = `## Active Breakpoints\n\n`;
            markdown += `**Total:** ${counts.total} (${counts.breakpoints} breakpoint${counts.breakpoints !== 1 ? 's' : ''}, ${counts.logpoints} logpoint${counts.logpoints !== 1 ? 's' : ''}`;
            if (pendingCount > 0) {
              markdown += `, ${pendingCount} pending`;
            }
            markdown += `)\n\n`;

            if (breakpoints.length === 0) {
              markdown += 'No active breakpoints.\n\n';
              markdown += '**TIP:** Use `breakpoint({ action: \'set\' })` to set a breakpoint or `breakpoint({ action: \'setLogpoint\' })` to set a logpoint.';
            } else {
              markdown += '| ID | Type | Status | Location |\n';
              markdown += '|---|---|---|---|\n';

              breakpoints.forEach(bp => {
                const type = bp.isLogpoint ? 'logpoint' : 'breakpoint';
                const status = bp.status === 'pending' ? '⏳ pending' : '✓ resolved';
                let location: string;
                if (bp.originalLocation) {
                  location = `${bp.originalLocation.url}:${bp.originalLocation.lineNumber}${bp.originalLocation.columnNumber !== undefined ? `:${bp.originalLocation.columnNumber}` : ''}`;
                } else {
                  // Fall back to scriptId-based location (CDP internal)
                  location = `scriptId:${bp.location.scriptId}:${bp.location.lineNumber + 1}${bp.location.columnNumber !== undefined ? `:${bp.location.columnNumber + 1}` : ''}`;
                }
                markdown += `| \`${bp.breakpointId}\` | ${type} | ${status} | \`${location}\` |\n`;
              });

              if (pendingCount > 0) {
                markdown += `\n**Note:** Pending breakpoints will activate when their scripts load.`;
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
          }

          case 'resetCounter': {
            if (!args.breakpointId) {
              return createErrorResponse('INVALID_PARAMS', { message: 'breakpointId is required for resetCounter action' });
            }

            // Reset the counter in the tracker
            if (!logpointTracker) {
              return createErrorResponse('DEBUGGER_NOT_CONNECTED');
            }

            const metadata = logpointTracker.getLogpoint(args.breakpointId);

            if (!metadata) {
              return createErrorResponse('BREAKPOINT_NOT_FOUND', { breakpointId: args.breakpointId });
            }

            // Reset the counter in the tracker
            const previousCount = metadata.executionCount;
            logpointTracker.resetCounter(args.breakpointId);

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
              breakpointId: args.breakpointId,
              maxExecutions: metadata.maxExecutions,
            });

            markdown += `\n\n**Logpoint Details:**\n`;
            markdown += `- **Location:** \`${metadata.url}:${metadata.lineNumber}\`\n`;
            markdown += `- **Log Message:** \`${metadata.logMessage}\`\n`;
            markdown += `- **Previous Count:** ${previousCount}\n`;
            markdown += `- **New Count:** 0\n`;
            markdown += `\n**Next Step:** Use \`execution({ action: 'resume' })\` to continue execution.`;

            return {
              content: [
                {
                  type: 'text',
                  text: markdown,
                },
              ],
            };
          }

          case 'validate': {
            if (!args.url || args.lineNumber === undefined || !args.logMessage) {
              return createErrorResponse('INVALID_PARAMS', { message: 'url, lineNumber, and logMessage are required for validate action' });
            }

            const timeout = args.timeout || 2000;

            // Parse logMessage to extract expressions
            const expressionMatches = args.logMessage.matchAll(/\{([^}]+)\}/g);
            const expressions: string[] = [];
            for (const match of expressionMatches) {
              expressions.push(match[1]);
            }

            if (expressions.length === 0) {
              const markdown = `## Logpoint Validation\n\n` +
                `**Status:** Valid\n` +
                `**Message:** No expressions to validate in log message\n` +
                `**Log Message:** \`${args.logMessage}\`\n\n` +
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
              const tempBreakpoint = await targetCdpManager.setBreakpoint(args.url, args.lineNumber, args.columnNumber);

              // Get actual location from CDP (0-based)
              const actualCdpLine = tempBreakpoint.location.lineNumber;
              const actualCdpColumn = tempBreakpoint.location.columnNumber;

              // Convert to 1-based for user display
              const actualLineUser = actualCdpLine + 1;
              const actualColumnUser = actualCdpColumn !== undefined ? actualCdpColumn + 1 : undefined;

              // Check if location differs
              const lineDiffers = actualLineUser !== args.lineNumber;
              const columnDiffers = args.columnNumber !== undefined && actualColumnUser !== args.columnNumber;
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
                markdown += `**Log Message:** \`${args.logMessage}\`\n\n`;
                markdown += `**Location:**\n`;
                markdown += `- **Requested:** Line ${args.lineNumber}${args.columnNumber ? `:${args.columnNumber}` : ''}\n`;
                markdown += `- **Actual:** Line ${actualLineUser}${actualColumnUser ? `:${actualColumnUser}` : ''}\n`;
                markdown += `- **Matched:** ${!locationDiffers ? 'Yes' : 'No'}\n\n`;

                if (locationDiffers) {
                  markdown += `**Warning:** CDP mapped your requested location ${args.lineNumber}:${args.columnNumber || 'auto'} to ${actualLineUser}:${actualColumnUser || 'auto'}\n\n`;
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
                  const result = await targetCdpManager.getVariables(callFrame.callFrameId, false);
                  availableVariables = result.variables.map((v: any) => v.name);
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
                const sourceResult = await targetCdpManager.getSourceCode(args.url, startLine, endLine);
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
              markdown += `- **Requested:** Line ${args.lineNumber}${args.columnNumber ? `:${args.columnNumber}` : ''}\n`;
              markdown += `- **Actual:** Line ${actualLineUser}${actualColumnUser ? `:${actualColumnUser}` : ''}\n`;
              markdown += `- **Matched:** ${!locationDiffers ? 'Yes' : 'No'}\n\n`;

              if (locationDiffers) {
                markdown += `**Warning:** CDP mapped your requested location ${args.lineNumber}:${args.columnNumber || 'auto'} to ${actualLineUser}:${actualColumnUser || 'auto'}\n\n`;
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
                    args.url,
                    args.lineNumber,
                    args.columnNumber,
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

          case 'setLogpoint': {
            if (!args.url || args.lineNumber === undefined || !args.logMessage) {
              return createErrorResponse('INVALID_PARAMS', { message: 'url, lineNumber, and logMessage are required for setLogpoint action' });
            }

            const includeCallStack = args.includeCallStack || false;
            const includeVariables = args.includeVariables || false;
            const maxExecutions = args.maxExecutions || 20;

            // Try to map through source maps if this is a TypeScript file
            let targetUrl = args.url;
            let targetLine = args.lineNumber;
            let targetColumn = args.columnNumber;

            if (args.url.endsWith('.ts')) {
              const mapped = await sourceMapHandler.mapToGenerated(args.url, args.lineNumber, args.columnNumber || 0);
              if (mapped) {
                targetUrl = mapped.generatedFile;
                targetLine = mapped.line;
                targetColumn = mapped.column;
              }
            }

            // Parse logMessage to extract expressions in {}
            const expressionMatches = args.logMessage.matchAll(/\{([^}]+)\}/g);
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
              let message = ${JSON.stringify(args.logMessage)};
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
            if (args.condition) {
              logExpression = `(${args.condition}) && ${logExpression}`;
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
              markdown += `- **Requested:** \`${args.url}:${args.lineNumber}\`\n`;
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
                  console.error(`[cdp-tools] Warning: Failed to remove invalid logpoint: ${removeError.message}`);
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
                    args.lineNumber,
                    args.columnNumber,
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
                errorMarkdown += `- **URL:** \`${args.url}\`\n`;
                errorMarkdown += `- **Line:** ${args.lineNumber}${args.columnNumber ? `:${args.columnNumber}` : ''}\n\n`;

                errorMarkdown += `**Actual Location (CDP Mapped):**\n`;
                errorMarkdown += `- **Line:** ${actualLineUser}${actualColumnUser ? `:${actualColumnUser}` : ''}\n`;
                errorMarkdown += `- **Offset:** ${actualLineUser - args.lineNumber > 0 ? '+' : ''}${actualLineUser - args.lineNumber} lines\n`;
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
                args.logMessage,
                maxExecutions
              );
            }

            // Inject console notification at resolved location
            await targetCdpManager.injectConsoleLink(targetUrl, actualLineUser, '📝 Logpoint set at');

            // Parse expressions to include in the response
            const expressionMatchesForResponse = args.logMessage.matchAll(/\{([^}]+)\}/g);
            const expressionsForResponse: string[] = [];
            for (const match of expressionMatchesForResponse) {
              expressionsForResponse.push(match[1]);
            }

            // Build markdown success response
            let markdown = `## Logpoint Set Successfully\n\n`;
            markdown += `**Breakpoint ID:** \`${breakpoint.breakpointId}\`\n`;
            markdown += `**Location:** \`${targetUrl}:${actualLineUser}${actualColumnUser ? `:${actualColumnUser}` : ''}\`\n`;
            markdown += `**Log Message:** \`${args.logMessage}\`\n`;

            if (expressionsForResponse.length > 0) {
              markdown += `**Expressions:** ${expressionsForResponse.map(e => `\`${e}\``).join(', ')}\n`;
            }

            if (args.condition) {
              markdown += `**Condition:** \`${args.condition}\`\n`;
            }

            markdown += `**Max Executions:** ${maxExecutions}\n\n`;

            // If location differs, add warning and validation info
            if (locationDiffers && expressions.length > 0) {
              markdown += `**⚠️ Warning:** Logpoint was set at line ${actualLineUser}:${actualColumnUser || 'auto'} (not ${args.lineNumber}:${args.columnNumber || 'auto'}) due to V8 line mapping. All expressions validated successfully at this location.\n\n`;
            } else if (locationDiffers) {
              markdown += `**⚠️ Note:** CDP mapped your requested location ${args.lineNumber}:${args.columnNumber || 'auto'} to ${actualLineUser}:${actualColumnUser || 'auto'}\n\n`;
            }

            markdown += `**Note:** This logpoint will log to the browser console without pausing execution`;

            if (expressionsForResponse.length > 0) {
              markdown += `\n\n**TIP:** Each expression is wrapped in try-catch. If an expression fails, it will show \`[Error: message]\` in the log.`;
              markdown += `\nTo see logpoint errors, use: \`console({ action: 'search', pattern: "Logpoint Error" })\``;
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

          case 'waitForScript': {
            if (!args.url) {
              return createErrorResponse('INVALID_PARAMS', { message: 'url is required for waitForScript action' });
            }

            const timeout = args.timeout || 10000;

            // Check connection
            if (!targetCdpManager.isConnected()) {
              return createErrorResponse('DEBUGGER_NOT_CONNECTED');
            }

            try {
              // First check if script is already loaded
              const existingScript = targetCdpManager.findLoadedScript(args.url);
              if (existingScript) {
                let markdown = `## Script Already Loaded\n\n`;
                markdown += `**Pattern:** \`${args.url}\`\n`;
                markdown += `**Matched URL:** \`${existingScript}\`\n`;
                markdown += `**Status:** ✓ Script is already loaded\n\n`;
                markdown += `**Next Step:** You can now set breakpoints on this script using \`breakpoint({ action: 'set', url: '${existingScript}', lineNumber: <line> })\``;

                return {
                  content: [{
                    type: 'text',
                    text: markdown,
                  }],
                };
              }

              // Script not loaded, wait for it
              const matchedUrl = await targetCdpManager.waitForScript(args.url, timeout);

              let markdown = `## Script Loaded\n\n`;
              markdown += `**Pattern:** \`${args.url}\`\n`;
              markdown += `**Matched URL:** \`${matchedUrl}\`\n`;
              markdown += `**Status:** ✓ Script loaded successfully\n\n`;
              markdown += `**Next Step:** You can now set breakpoints on this script using \`breakpoint({ action: 'set', url: '${matchedUrl}', lineNumber: <line> })\``;

              return {
                content: [{
                  type: 'text',
                  text: markdown,
                }],
              };
            } catch (error: any) {
              // Timeout or other error
              let markdown = `## Script Wait Timeout\n\n`;
              markdown += `**Pattern:** \`${args.url}\`\n`;
              markdown += `**Timeout:** ${timeout}ms\n`;
              markdown += `**Error:** ${error.message}\n\n`;

              // List some loaded scripts as hints
              const loadedScripts = targetCdpManager.getLoadedScripts();
              if (loadedScripts.length > 0) {
                markdown += `**Currently Loaded Scripts (first 10):**\n`;
                loadedScripts.slice(0, 10).forEach(url => {
                  markdown += `- \`${url}\`\n`;
                });
                if (loadedScripts.length > 10) {
                  markdown += `- ... and ${loadedScripts.length - 10} more\n`;
                }
                markdown += `\n`;
              }

              markdown += `**Suggestions:**\n`;
              markdown += `- Check that the URL pattern is correct\n`;
              markdown += `- Use \`navigate({ action: 'goto' })\` to load the page containing the script\n`;
              markdown += `- Increase the timeout if the script loads slowly`;

              return {
                content: [{
                  type: 'text',
                  text: markdown,
                }],
                isError: true,
              };
            }
          }

          default:
            return createErrorResponse('INVALID_ACTION', { action });
        }
      }
    ),
  };
}
