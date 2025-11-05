#!/usr/bin/env node

/**
 * LLM CDP Debugger MCP Server
 * Provides Chrome DevTools Protocol debugging capabilities to LLMs
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { CDPManager } from './cdp-manager.js';
import { SourceMapHandler } from './sourcemap-handler.js';
import { ChromeLauncher } from './chrome-launcher.js';
import { PuppeteerManager } from './puppeteer-manager.js';
import { ConsoleMonitor } from './console-monitor.js';
import { NetworkMonitor } from './network-monitor.js';
import { createBreakpointTools } from './tools/breakpoint-tools.js';
import { createExecutionTools } from './tools/execution-tools.js';
import { createInspectionTools } from './tools/inspection-tools.js';
import { createConsoleTools } from './tools/console-tools.js';
import { createNetworkTools } from './tools/network-tools.js';
import { createPageTools } from './tools/page-tools.js';
import { createDOMTools } from './tools/dom-tools.js';
import { createScreenshotTools } from './tools/screenshot-tools.js';
import { createInputTools } from './tools/input-tools.js';
import { createStorageTools } from './tools/storage-tools.js';

// Initialize managers
const cdpManager = new CDPManager();
const sourceMapHandler = new SourceMapHandler();
const chromeLauncher = new ChromeLauncher();
const puppeteerManager = new PuppeteerManager();
const consoleMonitor = new ConsoleMonitor();
const networkMonitor = new NetworkMonitor();

// Create MCP server
const server = new Server(
  {
    name: 'llm-cdp-debugger',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Connection management tools
const connectionTools = {
  launchChrome: {
    description: 'Launch Chrome with debugging enabled',
    inputSchema: {
      type: 'object',
      properties: {
        port: {
          type: 'number',
          description: 'The debugging port (default: 9222)',
        },
        url: {
          type: 'string',
          description: 'Optional URL to open (default: blank page)',
        },
      },
    },
    handler: async (args: any) => {
      const port = args.port || 9222;
      const url = args.url;

      try {
        const result = await chromeLauncher.launch(port, url);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: `Chrome launched with debugging on port ${result.port}`,
                port: result.port,
                pid: result.pid,
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
                success: false,
                error: `Failed to launch Chrome: ${error}`,
              }, null, 2),
            },
          ],
        };
      }
    },
  },

  killChrome: {
    description: 'Kill the Chrome process launched by this server',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      try {
        chromeLauncher.kill();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'Chrome process killed',
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
                success: false,
                error: `Failed to kill Chrome: ${error}`,
              }, null, 2),
            },
          ],
        };
      }
    },
  },

  resetChromeLauncher: {
    description: 'Reset Chrome launcher state (use if Chrome was closed externally)',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      chromeLauncher.reset();

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: 'Chrome launcher state reset',
            }, null, 2),
          },
        ],
      };
    },
  },

  getChromeStatus: {
    description: 'Get Chrome launcher status',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const status = chromeLauncher.getStatus();

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              chrome: status,
            }, null, 2),
          },
        ],
      };
    },
  },

  connectDebugger: {
    description: 'Connect to a Chrome or Node.js debugger instance',
    inputSchema: {
      type: 'object',
      properties: {
        host: {
          type: 'string',
          description: 'The debugger host (default: localhost)',
        },
        port: {
          type: 'number',
          description: 'The debugger port (default: 9222 for Chrome, 9229 for Node.js)',
        },
      },
    },
    handler: async (args: any) => {
      const host = args.host || 'localhost';
      const port = args.port || 9222;

      try {
        // Connect both CDP and Puppeteer
        await cdpManager.connect(host, port);
        await puppeteerManager.connect(host, port);

        // Start monitoring console and network
        const page = puppeteerManager.getPage();
        consoleMonitor.startMonitoring(page);
        networkMonitor.startMonitoring(page);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: `Connected to debugger at ${host}:${port}`,
                features: ['debugging', 'browser-automation', 'console-monitoring', 'network-monitoring'],
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
                success: false,
                error: `Failed to connect: ${error}`,
              }, null, 2),
            },
          ],
        };
      }
    },
  },

  disconnectDebugger: {
    description: 'Disconnect from the debugger',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      // Stop monitoring
      if (puppeteerManager.isConnected()) {
        const page = puppeteerManager.getPage();
        consoleMonitor.stopMonitoring(page);
        networkMonitor.stopMonitoring(page);
      }

      // Disconnect both managers
      await cdpManager.disconnect();
      await puppeteerManager.disconnect();

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: 'Disconnected from debugger',
            }, null, 2),
          },
        ],
      };
    },
  },

  loadSourceMaps: {
    description: 'Load source maps from a directory (for TypeScript debugging)',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'The directory containing .js.map files',
        },
      },
      required: ['directory'],
    },
    handler: async (args: any) => {
      const { directory } = args;

      try {
        await sourceMapHandler.loadSourceMapsFromDirectory(directory);
        const loadedMaps = sourceMapHandler.getLoadedSourceMaps();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: `Loaded ${loadedMaps.length} source maps`,
                sourceMaps: loadedMaps,
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
                success: false,
                error: `Failed to load source maps: ${error}`,
              }, null, 2),
            },
          ],
        };
      }
    },
  },

  getDebuggerStatus: {
    description: 'Get the current status of the debugger connection',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const connected = cdpManager.isConnected();
      const paused = cdpManager.isPaused();
      const breakpoints = cdpManager.getBreakpoints();
      const sourceMaps = sourceMapHandler.getLoadedSourceMaps();

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              connected,
              paused,
              breakpointCount: breakpoints.length,
              sourceMapCount: sourceMaps.length,
            }, null, 2),
          },
        ],
      };
    },
  },
};

// Combine all tools
const allTools = {
  ...connectionTools,
  // CDP Debugging tools
  ...createBreakpointTools(cdpManager, sourceMapHandler),
  ...createExecutionTools(cdpManager),
  ...createInspectionTools(cdpManager, sourceMapHandler),
  // Browser Automation tools
  ...createConsoleTools(puppeteerManager, consoleMonitor),
  ...createNetworkTools(puppeteerManager, networkMonitor),
  ...createPageTools(puppeteerManager, cdpManager),
  ...createDOMTools(puppeteerManager, cdpManager),
  ...createScreenshotTools(puppeteerManager, cdpManager),
  ...createInputTools(puppeteerManager, cdpManager),
  ...createStorageTools(puppeteerManager, cdpManager),
};

// Register tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: Object.entries(allTools).map(([name, tool]) => ({
      name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const tool = allTools[toolName as keyof typeof allTools];

  if (!tool) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: `Unknown tool: ${toolName}` }),
        },
      ],
    };
  }

  try {
    return await tool.handler(request.params.arguments || {});
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: `Tool execution failed: ${error}`,
          }),
        },
      ],
      isError: true,
    };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Cleanup on exit
  process.on('SIGINT', async () => {
    await cdpManager.disconnect();
    await puppeteerManager.disconnect();
    sourceMapHandler.clear();
    consoleMonitor.clear();
    networkMonitor.clear();
    chromeLauncher.kill();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
