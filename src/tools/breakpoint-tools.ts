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
  };
}
