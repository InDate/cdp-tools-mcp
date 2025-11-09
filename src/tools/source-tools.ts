/**
 * Source Code Tools
 */

import { z } from 'zod';
import { CDPManager } from '../cdp-manager.js';
import { SourceMapHandler } from '../sourcemap-handler.js';
import { createTool } from '../validation-helpers.js';
import { createSuccessResponse, createErrorResponse, formatCodeBlock } from '../messages.js';

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

          // Format source code with line numbers
          const codeBlock = formatCodeBlock(sourceCode.code, 'javascript');

          return createSuccessResponse('SOURCE_CODE_SUCCESS', {
            url,
            startLine: (startLine || 1).toString(),
            endLine: (endLine || sourceCode.totalLines).toString(),
          }, {
            totalLines: sourceCode.totalLines,
            hasSourceMap: sourceCode.hasSourceMap,
            code: codeBlock,
          });
        } catch (error) {
          return createErrorResponse('SOURCE_CODE_FAILED', { error: `${error}` });
        }
      }
    ),
  };
}
