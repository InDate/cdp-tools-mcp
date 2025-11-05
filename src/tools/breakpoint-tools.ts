/**
 * Breakpoint Management Tools
 */

import { CDPManager } from '../cdp-manager.js';
import { SourceMapHandler } from '../sourcemap-handler.js';

export function createBreakpointTools(cdpManager: CDPManager, sourceMapHandler: SourceMapHandler) {
  return {
    setBreakpoint: {
      description: 'Set a breakpoint at a specific file and line number',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The file URL or path (e.g., file:///path/to/file.js or http://localhost:3000/app.js)',
          },
          lineNumber: {
            type: 'number',
            description: 'The line number (1-based)',
          },
          columnNumber: {
            type: 'number',
            description: 'The column number (optional, 0-based)',
          },
        },
        required: ['url', 'lineNumber'],
      },
      handler: async (args: any) => {
        const { url, lineNumber, columnNumber } = args;

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

        const breakpoint = await cdpManager.setBreakpoint(targetUrl, targetLine, targetColumn);

        // Inject clickable console link
        await cdpManager.injectConsoleLink(targetUrl, targetLine, '🔴 Breakpoint set at');

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                breakpointId: breakpoint.breakpointId,
                location: breakpoint.location,
                originalLocation: breakpoint.originalLocation,
                message: `Breakpoint set at ${targetUrl}:${targetLine}`,
                consoleLink: `Console link injected - click in browser to open source`,
              }, null, 2),
            },
          ],
        };
      },
    },

    removeBreakpoint: {
      description: 'Remove a specific breakpoint by its ID',
      inputSchema: {
        type: 'object',
        properties: {
          breakpointId: {
            type: 'string',
            description: 'The breakpoint ID to remove',
          },
        },
        required: ['breakpointId'],
      },
      handler: async (args: any) => {
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
      },
    },

    listBreakpoints: {
      description: 'List all active breakpoints',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async () => {
        const breakpoints = cdpManager.getBreakpoints();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                breakpoints: breakpoints.map(bp => ({
                  breakpointId: bp.breakpointId,
                  location: bp.location,
                  originalLocation: bp.originalLocation,
                })),
                count: breakpoints.length,
              }, null, 2),
            },
          ],
        };
      },
    },

    setLogpoint: {
      description: 'Set a logpoint that logs without pausing execution (like Chrome DevTools Logpoints)',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The file URL or path',
          },
          lineNumber: {
            type: 'number',
            description: 'The line number (1-based)',
          },
          logMessage: {
            type: 'string',
            description: 'Message to log. Use {expression} for variable interpolation, e.g., "User: {user.name} ID: {user.id}"',
          },
          condition: {
            type: 'string',
            description: 'Optional condition - only log when this evaluates to true',
          },
          includeCallStack: {
            type: 'boolean',
            description: 'Include call stack in log output (default: false)',
          },
          includeVariables: {
            type: 'boolean',
            description: 'Include local variables in log output (default: false)',
          },
        },
        required: ['url', 'lineNumber', 'logMessage'],
      },
      handler: async (args: any) => {
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
              console.warn('[Logpoint] Error:', e.message);
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

        // Inject console notification
        await cdpManager.injectConsoleLink(targetUrl, targetLine, '📝 Logpoint set at');

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                breakpointId: result.breakpointId,
                location: result.locations[0],
                logMessage,
                condition: condition || 'none',
                message: `Logpoint set at ${targetUrl}:${targetLine}`,
                note: 'This logpoint will log to the browser console without pausing execution',
              }, null, 2),
            },
          ],
        };
      },
    },
  };
}
