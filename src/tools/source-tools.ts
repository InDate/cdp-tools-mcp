/**
 * Source Code Tools
 */

import { z } from 'zod';
import { CDPManager } from '../cdp-manager.js';
import { SourceMapHandler } from '../sourcemap-handler.js';
import { createTool } from '../validation-helpers.js';

// Schema for getSourceCode
const getSourceCodeSchema = z.object({
  url: z.string().describe('The file URL or path (e.g., file:///path/to/file.js or http://localhost:3000/app.js)'),
  startLine: z.number().optional().describe('Starting line number (1-based, optional - if not provided, returns entire file)'),
  endLine: z.number().optional().describe('Ending line number (1-based, optional - if not provided with startLine, returns 10 lines)'),
}).strict();

export function createSourceTools(cdpManager: CDPManager, sourceMapHandler: SourceMapHandler) {
  return {
    getSourceCode: createTool(
      'Get source code from a file at a specific line range. Useful for viewing code at breakpoint locations without reading files separately.',
      getSourceCodeSchema,
      async (args) => {
        const { url, startLine, endLine } = args;

        try {
          const sourceCode = await cdpManager.getSourceCode(url, startLine, endLine);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  url,
                  startLine: startLine || 1,
                  endLine: endLine || sourceCode.totalLines,
                  totalLines: sourceCode.totalLines,
                  sourceMap: sourceCode.hasSourceMap,
                  code: sourceCode.code,
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
                  error: `Failed to get source code: ${error}`,
                  url,
                }, null, 2),
              },
            ],
          };
        }
      }
    ),
  };
}
