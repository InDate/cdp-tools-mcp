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

import { z } from 'zod';
import { CDPManager } from './cdp-manager.js';
import { SourceMapHandler } from './sourcemap-handler.js';
import { ChromeLauncher } from './chrome-launcher.js';
import { PuppeteerManager } from './puppeteer-manager.js';
import { ConsoleMonitor } from './console-monitor.js';
import { NetworkMonitor } from './network-monitor.js';
import { ConnectionManager } from './connection-manager.js';
import { LogpointExecutionTracker } from './logpoint-execution-tracker.js';
import { validateParams, createTool } from './validation-helpers.js';
import { createBreakpointTools } from './tools/breakpoint-tools.js';
import { createExecutionTools } from './tools/execution-tools.js';
import { createInspectionTools } from './tools/inspection-tools.js';
import { createSourceTools } from './tools/source-tools.js';
import { createConsoleTools } from './tools/console-tools.js';
import { createNetworkTools } from './tools/network-tools.js';
import { createPageTools } from './tools/page-tools.js';
import { createDOMTools } from './tools/dom-tools.js';
import { createScreenshotTools } from './tools/screenshot-tools.js';
import { createInputTools } from './tools/input-tools.js';
import { createStorageTools } from './tools/storage-tools.js';
import { createServer } from 'net';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Find an available port starting from the given port
 */
async function findAvailablePort(startPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();

    // Explicitly bind to IPv4 localhost to match Chrome's behavior
    server.listen(startPort, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      console.error(`[llm-cdp] findAvailablePort: Port ${port} is available`);
      server.close(() => resolve(port));
    });

    server.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        // Port in use, try next one
        console.error(`[llm-cdp] findAvailablePort: Port ${startPort} is in use, trying ${startPort + 1}`);
        resolve(findAvailablePort(startPort + 1));
      } else {
        reject(err);
      }
    });
  });
}

/**
 * Get the debug port from environment variable or auto-assign
 */
async function getDebugPort(): Promise<number> {
  const envPort = process.env.MCP_DEBUG_PORT;

  if (envPort) {
    const port = parseInt(envPort, 10);
    if (isNaN(port) || port < 1024 || port > 65535) {
      console.error(`Invalid MCP_DEBUG_PORT: ${envPort}. Using auto-assigned port.`);
      return findAvailablePort(9222);
    }
    return port;
  }

  // Auto-assign starting from 9222
  return findAvailablePort(9222);
}

// Get the debug port (will be initialized in main())
let DEBUG_PORT = 9222;

/**
 * Get the current debug port (exported for use in error messages)
 */
export function getConfiguredDebugPort(): number {
  return DEBUG_PORT;
}

/**
 * Load instructions from docs/instructions.md
 */
async function loadInstructions(): Promise<string | undefined> {
  try {
    const instructionsPath = join(__dirname, '..', 'docs', 'instructions.md');
    return await readFile(instructionsPath, 'utf-8');
  } catch (error) {
    console.error('[llm-cdp] Failed to load instructions file:', error instanceof Error ? error.message : error);
    return undefined;
  }
}

// Initialize global managers
const sourceMapHandler = new SourceMapHandler();
const chromeLauncher = new ChromeLauncher();
const connectionManager = new ConnectionManager();
const logpointTracker = new LogpointExecutionTracker();

/**
 * Create and configure the MCP server with instructions
 */
async function createMCPServer(): Promise<Server> {
  const instructions = await loadInstructions();

  return new Server(
    {
      name: 'llm-cdp-debugger',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
      instructions,
    }
  );
}

/**
 * Wait for Chrome debugging port to become ready
 * Polls the /json/version endpoint until Chrome is inspectable
 */
async function waitForChromeReady(port: number, maxAttempts: number = 10): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1000);

      const response = await fetch(`http://localhost:${port}/json/version`, {
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        // Chrome is ready and inspectable
        return;
      }
    } catch (error) {
      // Chrome not ready yet, continue polling
    }

    // Exponential backoff: 500ms + (attempt * 200ms)
    await new Promise(resolve => setTimeout(resolve, 500 + i * 200));
  }

  throw new Error(`Chrome debugging port ${port} failed to become inspectable within timeout. Try increasing the wait time or check if Chrome started correctly.`);
}

// Connection management tools
const connectionTools = {
  launchChrome: createTool(
    'Launch Chrome with debugging enabled and optionally auto-connect',
    z.object({
      url: z.string().optional().describe('Optional URL to open (default: blank page)'),
      autoConnect: z.boolean().optional().default(true).describe('Automatically connect debugger after launch (default: true)'),
      port: z.number().optional().describe('The debugging port (optional, defaults to this session\'s auto-assigned port). Use this to launch multiple Chrome instances on different ports.'),
    }).strict(),
    async (args) => {
      const port = args.port || await findAvailablePort(getConfiguredDebugPort());
      console.error(`[llm-cdp] launchChrome: Using port ${port} (requested: ${args.port}, configured: ${getConfiguredDebugPort()})`);
      const url = args.url;
      const autoConnect = args.autoConnect ?? true;

      try {
        const result = await chromeLauncher.launch(port, url);

        // Auto-connect if requested
        let connectionId: string | undefined;
        let runtimeType: string | undefined;
        let features: string[] = [];

        if (autoConnect) {
          try {
            // Wait for Chrome to become ready and inspectable
            await waitForChromeReady(port);

            // Create connection managers for this connection
            const cdpManager = new CDPManager(sourceMapHandler);
            const puppeteerManager = new PuppeteerManager();
            const consoleMonitor = new ConsoleMonitor();
            const networkMonitor = new NetworkMonitor();

            // Connect to CDP
            await cdpManager.connect('localhost', port);
            runtimeType = cdpManager.getRuntimeType();
            features = ['debugging'];

            // Connect Puppeteer for Chrome
            if (runtimeType === 'chrome') {
              await puppeteerManager.connect('localhost', port);

              // Start monitoring console and network
              const page = puppeteerManager.getPage();
              consoleMonitor.startMonitoring(page);
              networkMonitor.startMonitoring(page);

              // Auto-reload page to capture initial console logs
              const currentUrl = page.url();
              if (currentUrl && currentUrl !== 'about:blank') {
                try {
                  // Use 'load' instead of 'networkidle0' for compatibility with file:// URLs
                  await page.reload({ waitUntil: 'load', timeout: 5000 });
                  await new Promise(resolve => setTimeout(resolve, 500));
                } catch (reloadError: any) {
                  // Log warning but don't fail - page might already be loaded
                  console.error(`[llm-cdp] Warning: Page reload failed: ${reloadError.message}`);
                }
              }

              features.push('browser-automation', 'console-monitoring', 'network-monitoring');
            }

            // Register connection
            connectionId = connectionManager.createConnection(
              cdpManager,
              puppeteerManager,
              consoleMonitor,
              networkMonitor,
              'localhost',
              port
            );

            // Update active manager references
            updateActiveManagers(connectionId);

            // Get console log summary for Chrome connections
            if (runtimeType === 'chrome') {
              const allMessages = consoleMonitor.getMessages({});
              const errorCount = allMessages.filter(m => m.type === 'error').length;
              const warnCount = allMessages.filter(m => m.type === 'warn').length;
              const logCount = allMessages.filter(m => m.type === 'log').length;
              features.push(`consoleLogs: ${allMessages.length} (${errorCount} errors, ${warnCount} warnings)`);
            }
          } catch (connectError) {
            // If auto-connect fails, still return success for launch
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    message: `Chrome launched with debugging on port ${result.port}`,
                    port: result.port,
                    pid: result.pid,
                    autoConnectFailed: true,
                    autoConnectError: `${connectError}`,
                    note: 'Chrome launched successfully but auto-connect failed. Use connectDebugger() to connect manually.',
                  }, null, 2),
                },
              ],
            };
          }
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: autoConnect
                  ? `Chrome launched and debugger connected on port ${result.port}`
                  : `Chrome launched with debugging on port ${result.port}`,
                port: result.port,
                pid: result.pid,
                ...(autoConnect && {
                  connectionId,
                  runtimeType,
                  features,
                  note: 'Console monitoring auto-enabled. Page auto-reloaded to capture initial logs.',
                }),
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
    }
  ),

  killChrome: createTool(
    'Kill the Chrome process launched by this server',
    z.object({}).strict(),
    async () => {
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
    }
  ),

  resetChromeLauncher: createTool(
    'Reset Chrome launcher state (use if Chrome was closed externally)',
    z.object({}).strict(),
    async () => {
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
    }
  ),

  getChromeStatus: createTool(
    'Get Chrome launcher status',
    z.object({}).strict(),
    async () => {
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
    }
  ),

  connectDebugger: createTool(
    'Connect to a Chrome or Node.js debugger instance',
    z.object({
      host: z.string().optional().default('localhost').describe('The debugger host (default: localhost)'),
      port: z.number().optional().describe('The debugger port (optional, defaults to this session\'s auto-assigned port). Use this to connect to debuggers on different ports (e.g., Node.js on 9229, Chrome on 9222).'),
    }).strict(),
    async (args) => {
      const host = args.host || 'localhost';
      const port = args.port || getConfiguredDebugPort();

      try {
        // Create new managers for this connection
        const cdpManager = new CDPManager(sourceMapHandler);
        const puppeteerManager = new PuppeteerManager();
        const consoleMonitor = new ConsoleMonitor();
        const networkMonitor = new NetworkMonitor();

        // Connect CDP first to detect runtime type
        await cdpManager.connect(host, port);
        const runtimeType = cdpManager.getRuntimeType();

        const features = ['debugging'];

        // Only connect Puppeteer for Chrome (browser automation)
        if (runtimeType === 'chrome') {
          await puppeteerManager.connect(host, port);

          // Start monitoring console and network
          const page = puppeteerManager.getPage();
          consoleMonitor.startMonitoring(page);
          networkMonitor.startMonitoring(page);

          // Auto-reload page to capture initial console logs
          // Skip reload for blank pages (nothing to reload)
          const currentUrl = page.url();
          if (currentUrl && currentUrl !== 'about:blank') {
            try {
              // Use 'load' instead of 'networkidle0' for compatibility with file:// URLs
              await page.reload({ waitUntil: 'load', timeout: 5000 });
              // Wait a bit more for all scripts to execute and errors to fire
              await new Promise(resolve => setTimeout(resolve, 500));
            } catch (reloadError: any) {
              // Log warning but don't fail - page might already be loaded
              console.error(`[llm-cdp] Warning: Page reload failed: ${reloadError.message}`);
            }
          }

          features.push('browser-automation', 'console-monitoring', 'network-monitoring');
        }

        // Register connection with ConnectionManager
        const connectionId = connectionManager.createConnection(
          cdpManager,
          runtimeType === 'chrome' ? puppeteerManager : undefined,
          runtimeType === 'chrome' ? consoleMonitor : undefined,
          runtimeType === 'chrome' ? networkMonitor : undefined,
          host,
          port
        );

        // Update active manager references
        updateActiveManagers(connectionId);

        // Get console log summary for Chrome connections
        let consoleLogSummary;
        if (runtimeType === 'chrome') {
          const connection = connectionManager.getConnection(connectionId);
          if (connection?.consoleMonitor) {
            const allMessages = connection.consoleMonitor.getMessages({});
            const errorCount = allMessages.filter(m => m.type === 'error').length;
            const warnCount = allMessages.filter(m => m.type === 'warn').length;
            const logCount = allMessages.filter(m => m.type === 'log').length;
            consoleLogSummary = {
              total: allMessages.length,
              errors: errorCount,
              warnings: warnCount,
              logs: logCount,
            };
          }
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                connectionId,
                message: `Connected to ${runtimeType} debugger at ${host}:${port}`,
                runtimeType,
                features,
                ...(consoleLogSummary && { consoleLogs: consoleLogSummary }),
                note: runtimeType === 'chrome'
                  ? 'Console monitoring auto-enabled. Page auto-reloaded to capture initial logs.'
                  : runtimeType === 'node'
                  ? 'Browser automation features are not available for Node.js debugging'
                  : undefined,
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
    }
  ),

  disconnectDebugger: createTool(
    'Disconnect from the debugger',
    z.object({
      connectionId: z.string().optional().describe('Connection ID to disconnect (optional, defaults to active connection)'),
    }).strict(),
    async (args) => {
      const connectionId = args.connectionId || connectionManager.getActiveConnectionId();

      if (!connectionId) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: 'No active connection',
              }, null, 2),
            },
          ],
        };
      }

      const success = await connectionManager.closeConnection(connectionId);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success,
              message: success ? `Disconnected from connection ${connectionId}` : 'Connection not found',
            }, null, 2),
          },
        ],
      };
    }
  ),

  loadSourceMaps: createTool(
    'Load source maps from a directory (for TypeScript debugging)',
    z.object({
      directory: z.string().describe('The directory containing .js.map files'),
    }).strict(),
    async (args) => {
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
    }
  ),

  getDebuggerStatus: createTool(
    'Get the current status of the debugger connection',
    z.object({
      connectionId: z.string().optional().describe('Connection ID to check (optional, defaults to active connection)'),
    }).strict(),
    async (args) => {
      const connectionId = args.connectionId;
      const connection = connectionManager.getConnection(connectionId);

      if (!connection) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                connected: false,
                message: 'No active connection',
                totalConnections: connectionManager.getConnectionCount(),
              }, null, 2),
            },
          ],
        };
      }

      const cdpManager = connection.cdpManager;
      const puppeteerManager = connection.puppeteerManager;
      const consoleMonitor = connection.consoleMonitor;
      const networkMonitor = connection.networkMonitor;
      const connected = cdpManager.isConnected();
      const runtimeType = cdpManager.getRuntimeType();
      const paused = cdpManager.isPaused();
      const breakpointCounts = cdpManager.getBreakpointCounts();
      const sourceMaps = sourceMapHandler.getLoadedSourceMaps();
      const puppeteerConnected = puppeteerManager?.isConnected() || false;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              connectionId: connection.id,
              connected,
              runtimeType,
              puppeteerConnected,
              paused,
              breakpoints: breakpointCounts.breakpoints,
              logpoints: breakpointCounts.logpoints,
              totalBreakpoints: breakpointCounts.total,
              sourceMapCount: sourceMaps.length,
              consoleMonitoring: consoleMonitor?.isActive() ? 'active' : 'inactive',
              networkMonitoring: networkMonitor?.isActive() ? 'active' : 'inactive',
              totalConnections: connectionManager.getConnectionCount(),
            }, null, 2),
          },
        ],
      };
    }
  ),

  listConnections: createTool(
    'List all active debugger connections',
    z.object({}).strict(),
    async () => {
      const connections = connectionManager.listConnections();
      const activeId = connectionManager.getActiveConnectionId();

      const connectionList = connections.map(conn => ({
        id: conn.id,
        type: conn.type,
        host: conn.host,
        port: conn.port,
        active: conn.id === activeId,
        connected: conn.cdpManager.isConnected(),
        paused: conn.cdpManager.isPaused(),
        createdAt: new Date(conn.createdAt).toISOString(),
      }));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              totalConnections: connections.length,
              activeConnectionId: activeId,
              connections: connectionList,
            }, null, 2),
          },
        ],
      };
    }
  ),

  switchConnection: createTool(
    'Switch the active debugger connection',
    z.object({
      connectionId: z.string().describe('Connection ID to switch to'),
    }).strict(),
    async (args) => {
      const success = connectionManager.setActiveConnection(args.connectionId);

      if (success) {
        // Update active manager references
        updateActiveManagers(args.connectionId);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success,
              message: success
                ? `Switched to connection ${args.connectionId}`
                : `Connection ${args.connectionId} not found`,
              activeConnectionId: connectionManager.getActiveConnectionId(),
            }, null, 2),
          },
        ],
      };
    }
  ),
};

// Active connection manager references (updated when connection is made/switched)
let activeCdpManager: CDPManager | null = null;
let activePuppeteerManager: PuppeteerManager | null = null;
let activeConsoleMonitor: ConsoleMonitor | null = null;
let activeNetworkMonitor: NetworkMonitor | null = null;

// Helper to update active manager references
const updateActiveManagers = (connectionId?: string) => {
  const connection = connectionManager.getConnection(connectionId);
  if (connection) {
    activeCdpManager = connection.cdpManager;
    activePuppeteerManager = connection.puppeteerManager || null;
    activeConsoleMonitor = connection.consoleMonitor || null;
    activeNetworkMonitor = connection.networkMonitor || null;
  }
};

// Create proxy managers that delegate to active connection
const proxyHandlerForManager = {
  get(target: any, prop: string) {
    // For CDPManager
    if (target.constructor.name === 'CDPManager' && activeCdpManager) {
      return (activeCdpManager as any)[prop];
    }
    // For PuppeteerManager
    if (target.constructor.name === 'PuppeteerManager' && activePuppeteerManager) {
      return (activePuppeteerManager as any)[prop];
    }
    // For ConsoleMonitor
    if (target.constructor.name === 'ConsoleMonitor' && activeConsoleMonitor) {
      return (activeConsoleMonitor as any)[prop];
    }
    // For NetworkMonitor
    if (target.constructor.name === 'NetworkMonitor' && activeNetworkMonitor) {
      return (activeNetworkMonitor as any)[prop];
    }
    return target[prop];
  },
};

// Create proxy managers
const proxyCdpManager = new Proxy(new CDPManager(sourceMapHandler), proxyHandlerForManager);
const proxyPuppeteerManager = new Proxy(new PuppeteerManager(), proxyHandlerForManager);
const proxyConsoleMonitor = new Proxy(new ConsoleMonitor(), proxyHandlerForManager);
const proxyNetworkMonitor = new Proxy(new NetworkMonitor(), proxyHandlerForManager);

// Register logpoint tracker callbacks
proxyConsoleMonitor.onMessage((message: any) => {
  logpointTracker.handleConsoleMessage(message);
});

logpointTracker.setLimitExceededCallback((metadata) => {
  proxyCdpManager.handleLogpointLimitExceeded({
    breakpointId: metadata.breakpointId,
    url: metadata.url,
    lineNumber: metadata.lineNumber,
    logMessage: metadata.logMessage,
    executionCount: metadata.executionCount,
    maxExecutions: metadata.maxExecutions,
    logs: metadata.logs,
  });
});

// Combine all tools
const allTools = {
  ...connectionTools,
  // CDP Debugging tools
  ...createBreakpointTools(proxyCdpManager, sourceMapHandler, logpointTracker),
  ...createExecutionTools(proxyCdpManager),
  ...createInspectionTools(proxyCdpManager, sourceMapHandler),
  ...createSourceTools(proxyCdpManager, sourceMapHandler),
  // Browser Automation tools
  ...createConsoleTools(proxyPuppeteerManager, proxyConsoleMonitor),
  ...createNetworkTools(proxyPuppeteerManager, proxyNetworkMonitor),
  ...createPageTools(proxyPuppeteerManager, proxyCdpManager, proxyConsoleMonitor, proxyNetworkMonitor),
  ...createDOMTools(proxyPuppeteerManager, proxyCdpManager),
  ...createScreenshotTools(proxyPuppeteerManager, proxyCdpManager),
  ...createInputTools(proxyPuppeteerManager, proxyCdpManager),
  ...createStorageTools(proxyPuppeteerManager, proxyCdpManager),
};

/**
 * Register tool handlers on the server
 */
function registerToolHandlers(server: Server) {
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
            text: JSON.stringify({
              success: false,
              error: `Unknown tool: ${toolName}`,
              code: 'UNKNOWN_TOOL',
              availableTools: Object.keys(allTools).sort()
            }, null, 2),
          },
        ],
        isError: true
      };
    }

    // All tools now use Zod validation
    const validation = validateParams(
      request.params.arguments || {},
      (tool as any).zodSchema,
      toolName
    );

    if (!validation.success) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(validation.error, null, 2),
          },
        ],
        isError: true
      };
    }

    // Pass validated data to handler
    try {
      return await tool.handler(validation.data);
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: `Tool execution failed: ${error}`,
              code: 'EXECUTION_ERROR'
            }, null, 2),
          },
        ],
        isError: true
      };
    }
  });
}

// Start the server
async function main() {
  // Initialize debug port
  DEBUG_PORT = await getDebugPort();
  console.error(`[llm-cdp] Using debug port: ${DEBUG_PORT}`);

  // Create server with instructions
  const server = await createMCPServer();

  // Register tool handlers
  registerToolHandlers(server);

  // Connect to transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Cleanup on exit
  process.on('SIGINT', async () => {
    await connectionManager.closeAll();
    sourceMapHandler.clear();
    chromeLauncher.kill();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
