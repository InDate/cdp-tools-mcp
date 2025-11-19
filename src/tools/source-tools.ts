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
  url: z.string().describe('File URL or path'),
  startLine: z.number().optional().describe('Start line number'),
  endLine: z.number().optional().describe('End line number'),
  connectionReason: z.string().optional().describe('Connection reference (use the reference from launchChrome output, e.g., "unnamed-connection-default" or your renamed tab)'),
}).strict();

export function createSourceTools(
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
    getSourceCode: createTool(
      'Get source code at line range',
      getSourceCodeSchema,
      async (args) => {
        const { url, startLine, endLine, connectionReason } = args;

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
          const sourceCode = await targetCdpManager.getSourceCode(url, startLine, endLine);

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
