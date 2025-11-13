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
import { ConnectionManager, type Connection } from './connection-manager.js';
import { LogpointExecutionTracker } from './logpoint-execution-tracker.js';
import { PortReserver } from './port-reserver.js';
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
import { createContentTools } from './tools/content-tools.js';
import { createStorageTools } from './tools/storage-tools.js';
import { createTabTools } from './tools/tab-tools.js';
import { createDownloadTools } from './tools/download-tools.js';
import { createModalTools } from './tools/modal-tools.js';
import { createSuccessResponse, createErrorResponse, formatCodeBlock, getMessage } from './messages.js';
import { createServer } from 'net';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { debugLog, enableDebugLogging, disableDebugLogging, isDebugEnabled } from './debug-logger.js';
import { validateReference, UNNAMED_CONNECTION } from './reference-validator.js';

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
let RESERVED_PORT = 9222; // The port physically reserved by socket binding

/**
 * Get the current debug port (exported for use in error messages)
 */
export function getConfiguredDebugPort(): number {
  return DEBUG_PORT;
}

/**
 * Get the reserved port (the one we hold with socket binding)
 */
export function getReservedPort(): number {
  return RESERVED_PORT;
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
const portReserver = new PortReserver();

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

/**
 * Check if Chrome is running and accessible on the specified port
 * Returns true if Chrome is responding to debug protocol requests
 * Returns false if port is reserved (chrome-not-running) or connection fails
 */
async function isChromeRunning(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1000);

    const response = await fetch(`http://localhost:${port}/json/version`, {
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    // Check if this is the port reserver responding
    const text = await response.text();
    if (text.trim() === 'chrome-not-running') {
      return false;
    }

    // Otherwise, check if we got a valid Chrome response
    return response.ok;
  } catch {
    return false;
  }
}

// Connection management tools
const connectionTools = {
  launchChrome: createTool(
    'Launch Chrome with debugging enabled and optionally auto-connect',
    z.object({
      url: z.string().optional().describe('Optional URL to open (default: blank page)'),
      autoConnect: z.boolean().optional().default(true).describe('Automatically connect debugger after launch (default: true)'),
      port: z.number().optional().describe('The debugging port (optional, defaults to this session\'s reserved port). Use this to launch multiple Chrome instances on different ports.'),
      headless: z.boolean().optional().default(false).describe('Launch in headless mode (no visible window, prevents focus stealing). Default: false'),
    }).strict(),
    async (args) => {
      // Use reserved port unless explicitly specified
      const port = args.port || getReservedPort();
      await debugLog('index', `launchChrome called: port=${port}, requested=${args.port}, reserved=${getReservedPort()}, url=${args.url}, autoConnect=${args.autoConnect}`);
      const url = args.url;
      const autoConnect = args.autoConnect ?? true;

      try {
        // Check if Chrome is already running on this port (browser already exists)
        const browserAlreadyExists = connectionManager.hasBrowser('localhost', port);
        await debugLog('index', `browserAlreadyExists: ${browserAlreadyExists}`);
        let isNewBrowser = false;

        if (!browserAlreadyExists) {
          await debugLog('index', `Launching new Chrome instance on port ${port}...`);
          // Launch new Chrome instance (will release port reservation)
          const result = await chromeLauncher.launch(port, url, portReserver, args.headless);
          await debugLog('index', `Chrome launched successfully: ${JSON.stringify(result)}`);
          isNewBrowser = true;
        }

        // Auto-connect if requested
        let connectionId: string | undefined;
        let runtimeType: string | undefined;
        let title = 'New Tab';
        let pageUrl = 'about:blank';
        let consoleStats = '';

        if (autoConnect) {
          try {
            // Chrome is already ready (launch() waits for port binding)
            // Create connection managers for this tab
            const cdpManager = new CDPManager(sourceMapHandler);
            const puppeteerManager = new PuppeteerManager();
            const consoleMonitor = new ConsoleMonitor();
            const networkMonitor = new NetworkMonitor();

            // Connect to CDP
            await cdpManager.connect('localhost', port);
            runtimeType = cdpManager.getRuntimeType();

            // Connect Puppeteer for Chrome
            if (runtimeType === 'chrome') {
              await puppeteerManager.connect('localhost', port);

              // Create new tab if browser already existed, otherwise use existing page
              if (browserAlreadyExists) {
                await puppeteerManager.newPage();
              }

              // Start monitoring console and network
              const page = puppeteerManager.getPage();
              consoleMonitor.startMonitoring(page);
              networkMonitor.startMonitoring(page);

              // Navigate to URL if provided
              if (url) {
                await page.goto(url, { waitUntil: 'load', timeout: 30000 });
              }

              // Auto-reload page to capture initial console logs (only if not navigating and has content)
              const currentUrl = page.url();
              if (!url && currentUrl && currentUrl !== 'about:blank') {
                try {
                  await page.reload({ waitUntil: 'load', timeout: 5000 });
                  await new Promise(resolve => setTimeout(resolve, 500));
                } catch (reloadError: any) {
                  console.error(`[llm-cdp] Warning: Page reload failed: ${reloadError.message}`);
                }
              }
            }

            // Get page index for tracking
            const pages = await puppeteerManager.getPages();
            const currentPage = puppeteerManager.getPage();
            const pageIndex = pages.findIndex(p => p === currentPage);

            // Register connection
            connectionId = connectionManager.createConnection(
              cdpManager,
              puppeteerManager,
              consoleMonitor,
              networkMonitor,
              'localhost',
              port,
              undefined, // reference will be set later
              pageIndex
            );

            // Update active manager references
            updateActiveManagers(connectionId);

            // Get page info and console stats for Chrome connections
            if (runtimeType === 'chrome') {
              const page = puppeteerManager.getPage();
              pageUrl = page.url();
              title = await page.title();

              const allMessages = consoleMonitor.getMessages({});
              const errorCount = allMessages.filter(m => m.type === 'error').length;
              const warnCount = allMessages.filter(m => m.type === 'warn').length;
              consoleStats = `\nConsole: ${allMessages.length} logs (${errorCount} errors, ${warnCount} warnings)`;
            }
          } catch (connectError) {
            // If auto-connect fails, still return success for launch
            return createSuccessResponse('CHROME_LAUNCH_AUTO_CONNECT_FAILED', {
              port: port.toString(),
              error: `${connectError}`
            }, {
              port: port,
              isNewBrowser,
            });
          }
        }

        // Format response based on whether auto-connect was used
        if (autoConnect) {
          const connection = connectionManager.getConnection(connectionId);
          const reference = connection?.reference || UNNAMED_CONNECTION;

          const message = `Chrome launched and connected
Connection Reference: ${reference}
Title: ${title}
URL: ${pageUrl}${consoleStats}`;

          // Add instruction to provide tab reference
          const instruction = '\n\n**IMPORTANT:** Please provide a reference name for this tab using the `renameTab` tool (e.g., "wikipedia-search", "product-page").';

          return {
            content: [{ type: 'text', text: message + instruction }],
          };
        } else {
          return createSuccessResponse('CHROME_LAUNCH_NO_CONNECT', { port: port.toString() }, { port, isNewBrowser });
        }
      } catch (error) {
        return createErrorResponse('CHROME_SPAWN_FAILED', { error: `${error}` });
      }
    }
  ),

  killChrome: createTool(
    'Kill the Chrome process launched by this server',
    z.object({}).strict(),
    async () => {
      try {
        chromeLauncher.kill();

        // Clean up all connections for the browser that was killed
        const port = getReservedPort();
        const connectionsToClose = connectionManager.getConnectionsForBrowser('localhost', port);
        for (const conn of connectionsToClose) {
          await connectionManager.closeConnection(conn.id);
          console.error(`[llm-cdp] Closed connection ${conn.id} after killing Chrome`);
        }

        // Re-reserve the port immediately after killing Chrome
        try {
          await portReserver.reserve(port);
          console.error(`[llm-cdp] Re-reserved port ${port} after killing Chrome`);
        } catch (reserveError) {
          console.error(`[llm-cdp] Warning: Failed to re-reserve port ${port}: ${reserveError}`);
        }

        return createSuccessResponse('CHROME_KILLED');
      } catch (error) {
        return createErrorResponse('CHROME_SPAWN_FAILED', { error: `${error}` });
      }
    }
  ),

  resetChromeLauncher: createTool(
    'Reset Chrome launcher state (use if Chrome was closed externally)',
    z.object({}).strict(),
    async () => {
      chromeLauncher.reset();
      return createSuccessResponse('CHROME_LAUNCHER_RESET');
    }
  ),

  getChromeStatus: createTool(
    'Get Chrome launcher status',
    z.object({}).strict(),
    async () => {
      const status = chromeLauncher.getStatus();
      return createSuccessResponse('CHROME_STATUS', {}, status);
    }
  ),

  setDebugLogging: createTool(
    'Enable or disable debug logging for troubleshooting',
    z.object({
      enabled: z.boolean().describe('Set to true to enable debug logging, false to disable'),
    }).strict(),
    async (args) => {
      if (args.enabled) {
        enableDebugLogging();
        return createSuccessResponse('DEBUG_LOGGING_ENABLED', {
          message: 'Debug logging enabled. Logs will be written to .claude/logs/debug.log'
        }, {
          enabled: true,
          message: 'Debug logging enabled. Logs will be written to .claude/logs/debug.log'
        });
      } else {
        disableDebugLogging();
        return createSuccessResponse('DEBUG_LOGGING_DISABLED', {
          message: 'Debug logging disabled'
        }, {
          enabled: false,
          message: 'Debug logging disabled'
        });
      }
    }
  ),

  getDebugLoggingStatus: createTool(
    'Check if debug logging is currently enabled',
    z.object({}).strict(),
    async () => {
      const enabled = isDebugEnabled();
      return createSuccessResponse('DEBUG_LOGGING_STATUS', {
        status: enabled ? 'enabled' : 'disabled',
        enabled,  // Pass boolean for conditionals
        logFile: '.claude/logs/debug.log'
      }, {
        enabled,
        logFile: '.claude/logs/debug.log'
      });
    }
  ),

  connectDebugger: createTool(
    'Connect to a Chrome or Node.js debugger instance',
    z.object({
      reference: z.string().describe('3 descriptive words describing this debugging activity'),
      host: z.string().optional().default('localhost').describe('The debugger host (default: localhost)'),
      port: z.number().optional().describe('The debugger port (optional, defaults to this session\'s auto-assigned port). Use this to connect to debuggers on different ports (e.g., Node.js on 9229, Chrome on 9222).'),
    }).strict(),
    async (args) => {
      // Validate reference
      const validation = validateReference(args.reference);
      if (!validation.valid) {
        return createErrorResponse('INVALID_REFERENCE', {
          error: validation.error!
        });
      }

      // Use the sanitized reference from validation
      const reference = validation.sanitized!;

      // Check for duplicate reference
      if (connectionManager.findConnectionByReference(reference)) {
        return createErrorResponse('REFERENCE_IN_USE', {
          reference
        });
      }

      const host = args.host || 'localhost';
      const port = args.port || getConfiguredDebugPort();
      const defaultPort = getConfiguredDebugPort();
      const isDefaultPort = port === defaultPort;

      await debugLog('index', `connectDebugger called: host=${host}, port=${port}, defaultPort=${defaultPort}`);

      try {
        // Check if Chrome/debugger is running before attempting connection
        await debugLog('index', `Checking if Chrome is running on port ${port}...`);
        const isRunning = await isChromeRunning(port);
        await debugLog('index', `isChromeRunning result: ${isRunning}`);

        if (!isRunning) {
          await debugLog('index', `Chrome not running on port ${port}, returning error`);
          // Provide clear error message based on port type
          if (isDefaultPort && host === 'localhost') {
            return createErrorResponse('DEBUGGER_NOT_RUNNING', {
              port: port.toString(),
              message: `Chrome is not running on port ${port}. Use \`launchChrome()\` to start Chrome first.`
            });
          } else {
            return createErrorResponse('DEBUGGER_NOT_RUNNING', {
              port: port.toString(),
              message: `No debugger found on ${host}:${port}. For Chrome, use \`launchChrome({ port: ${port} })\`. For Node.js, start with \`node --inspect=${port} app.js\``
            });
          }
        }

        // Check if browser already exists on this port
        const browserAlreadyExists = connectionManager.hasBrowser(host, port);

        // Create new managers for this tab/connection
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

          // Create new tab if browser already existed
          if (browserAlreadyExists) {
            await puppeteerManager.newPage();
          }

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

        // Get page index for tracking
        let pageIndex: number | undefined;
        if (runtimeType === 'chrome') {
          const pages = await puppeteerManager.getPages();
          const currentPage = puppeteerManager.getPage();
          pageIndex = pages.findIndex(p => p === currentPage);
        }

        // Register connection with ConnectionManager
        const connectionId = connectionManager.createConnection(
          cdpManager,
          runtimeType === 'chrome' ? puppeteerManager : undefined,
          runtimeType === 'chrome' ? consoleMonitor : undefined,
          runtimeType === 'chrome' ? networkMonitor : undefined,
          host,
          port,
          reference, // Set reference from parameter
          pageIndex
        );

        // Update active manager references
        updateActiveManagers(connectionId);

        // Build markdown response using template
        let markdown = getMessage('DEBUGGER_CONNECT_SUCCESS', {
          runtimeType,
          host,
          port: port.toString(),
          reference,
          features: features.join(', ')
        });

        // Add console log summary for Chrome connections
        if (runtimeType === 'chrome') {
          const connection = connectionManager.getConnection(connectionId);
          if (connection?.consoleMonitor) {
            const allMessages = connection.consoleMonitor.getMessages({});
            const errorCount = allMessages.filter(m => m.type === 'error').length;
            const warnCount = allMessages.filter(m => m.type === 'warn').length;
            const logCount = allMessages.filter(m => m.type === 'log').length;
            markdown += `\n**Console Logs:** ${allMessages.length} total (${errorCount} errors, ${warnCount} warnings, ${logCount} logs)\n`;
          }
          markdown += '\n**Note:** Console monitoring auto-enabled. Page auto-reloaded to capture initial logs.';
          // Add instruction to provide tab reference
          markdown += '\n\n**IMPORTANT:** Please provide a reference name for this tab using the `renameTab` tool (e.g., "wikipedia-search", "product-page").';
        } else if (runtimeType === 'node') {
          markdown += '\n**Note:** Browser automation features are not available for Node.js debugging.';
        }

        return {
          content: [{ type: 'text', text: markdown.trim() }],
        };
      } catch (error) {
        return createErrorResponse('DEBUGGER_CONNECT_FAILED', {
          host,
          port: port.toString(),
          error: `${error}`
        });
      }
    }
  ),

  disconnectDebugger: createTool(
    'Disconnect from the debugger',
    z.object({
      reference: z.string().describe('3 descriptive words of the connection to disconnect'),
    }).strict(),
    async (args) => {
      // Find connection by reference
      const connection = connectionManager.findConnectionByReference(args.reference);

      if (!connection) {
        return createErrorResponse('CONNECTION_NOT_FOUND', {
          reference: args.reference
        });
      }

      const success = await connectionManager.closeConnection(connection.id);

      if (success) {
        return createSuccessResponse('DEBUGGER_DISCONNECT_SUCCESS', { reference: args.reference });
      } else {
        return createErrorResponse('CONNECTION_SWITCH_FAILED', { reference: args.reference });
      }
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

        return createSuccessResponse('SOURCE_MAPS_LOADED', {
          count: loadedMaps.length.toString(),
          directory
        }, { sourceMaps: loadedMaps });
      } catch (error) {
        return createErrorResponse('SOURCE_MAPS_FAILED', { error: `${error}` });
      }
    }
  ),

  getDebuggerStatus: createTool(
    'Get the current status of the debugger connection',
    z.object({
      reference: z.string().describe('3 descriptive words of the connection to check'),
    }).strict(),
    async (args) => {
      // Find connection by reference
      const connection = connectionManager.findConnectionByReference(args.reference);

      if (!connection) {
        return createErrorResponse('CONNECTION_NOT_FOUND', {
          reference: args.reference
        });
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

      const statusData = {
        reference: connection.reference || UNNAMED_CONNECTION,
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
      };

      return createSuccessResponse('CONNECTION_STATUS', {}, statusData);
    }
  ),

  listConnections: createTool(
    'List all active debugger connections',
    z.object({}).strict(),
    async () => {
      const connections = connectionManager.listConnections();
      const activeId = connectionManager.getActiveConnectionId();
      const activeConnection = activeId ? connectionManager.getConnection(activeId) : null;
      const activeReference = activeConnection?.reference || UNNAMED_CONNECTION;

      const connectionList = connections.map(conn => ({
        reference: conn.reference || UNNAMED_CONNECTION,
        type: conn.type,
        host: conn.host,
        port: conn.port,
        active: conn.id === activeId,
        connected: conn.cdpManager.isConnected(),
        paused: conn.cdpManager.isPaused(),
        createdAt: new Date(conn.createdAt).toISOString(),
      }));

      return createSuccessResponse('CONNECTIONS_LIST', {
        totalConnections: connections.length.toString()
      }, {
        activeReference,
        connections: connectionList,
      });
    }
  ),

  switchConnection: createTool(
    'Switch the active debugger connection',
    z.object({
      reference: z.string().describe('3 descriptive words of the connection to switch to'),
    }).strict(),
    async (args) => {
      // Find connection by reference
      const connection = connectionManager.findConnectionByReference(args.reference);

      if (!connection) {
        return createErrorResponse('CONNECTION_NOT_FOUND', {
          reference: args.reference
        });
      }

      const success = connectionManager.setActiveConnection(connection.id);

      if (success) {
        // Update active manager references
        updateActiveManagers(connection.id);
        return createSuccessResponse('CONNECTION_SWITCH_SUCCESS', { reference: args.reference });
      } else {
        return createErrorResponse('CONNECTION_SWITCH_FAILED', { reference: args.reference });
      }
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
    // Update activity timestamp whenever connection is accessed
    connectionManager.updateActivity(connection.id);
  }
};

/**
 * Resolve a connection from a connectionReason (task description)
 * Sanitizes the reason, looks for existing tab, or creates new one
 */
async function resolveConnectionFromReason(connectionReason: string): Promise<{
  connection: Connection;
  cdpManager: CDPManager;
  puppeteerManager: PuppeteerManager | null;
  consoleMonitor: ConsoleMonitor | null;
  networkMonitor: NetworkMonitor | null;
} | null> {
  // Sanitize: lowercase, trim, spaces to hyphens
  const reference = connectionReason.toLowerCase().trim().replace(/\s+/g, '-');

  // Find connection by reference only
  const connection = connectionManager.findConnectionByReference(reference);

  // If not found, return null to show error
  if (!connection) {
    return null;
  }

  // Update activity timestamp when connection is accessed
  connectionManager.updateActivity(connection.id);

  return {
    connection,
    cdpManager: connection.cdpManager,
    puppeteerManager: connection.puppeteerManager || null,
    consoleMonitor: connection.consoleMonitor || null,
    networkMonitor: connection.networkMonitor || null,
  };
}

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
  // Tab Management tools
  ...createTabTools(connectionManager, sourceMapHandler, updateActiveManagers),
  // CDP Debugging tools
  ...createBreakpointTools(proxyCdpManager, sourceMapHandler, logpointTracker, resolveConnectionFromReason),
  ...createExecutionTools(proxyCdpManager, resolveConnectionFromReason),
  ...createInspectionTools(proxyCdpManager, sourceMapHandler, resolveConnectionFromReason),
  ...createSourceTools(proxyCdpManager, sourceMapHandler, resolveConnectionFromReason),
  // Browser Automation tools
  ...createConsoleTools(proxyPuppeteerManager, proxyConsoleMonitor, resolveConnectionFromReason),
  ...createNetworkTools(proxyPuppeteerManager, proxyNetworkMonitor, resolveConnectionFromReason),
  ...createPageTools(proxyPuppeteerManager, proxyCdpManager, proxyConsoleMonitor, proxyNetworkMonitor, connectionManager, resolveConnectionFromReason),
  ...createDOMTools(proxyPuppeteerManager, proxyCdpManager, connectionManager, resolveConnectionFromReason),
  ...createScreenshotTools(proxyPuppeteerManager, proxyCdpManager, connectionManager, resolveConnectionFromReason),
  ...createInputTools(proxyPuppeteerManager, proxyCdpManager, connectionManager, resolveConnectionFromReason),
  ...createContentTools(proxyPuppeteerManager, proxyCdpManager, connectionManager, resolveConnectionFromReason),
  ...createModalTools(resolveConnectionFromReason),
  ...createStorageTools(proxyPuppeteerManager, proxyCdpManager, resolveConnectionFromReason),
  // Download tools
  ...createDownloadTools(),
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
  // Initialize and reserve debug port
  DEBUG_PORT = await getDebugPort();
  RESERVED_PORT = DEBUG_PORT;

  // Reserve the port by binding a socket to it
  try {
    await portReserver.reserve(RESERVED_PORT);
    console.error(`[llm-cdp] Reserved debug port: ${RESERVED_PORT}`);
  } catch (error) {
    console.error(`[llm-cdp] Failed to reserve port ${RESERVED_PORT}: ${error}`);
    process.exit(1);
  }

  // Create server with instructions
  const server = await createMCPServer();

  // Register tool handlers
  registerToolHandlers(server);

  // Connect to transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Start periodic cleanup of inactive connections (every 2 minutes)
  const CLEANUP_INTERVAL = 2 * 60 * 1000; // 2 minutes
  const INACTIVITY_THRESHOLD = 5 * 60 * 1000; // 5 minutes
  const cleanupInterval = setInterval(async () => {
    try {
      const closedCount = await connectionManager.closeInactiveConnections(INACTIVITY_THRESHOLD);
      if (closedCount > 0) {
        console.error(`[llm-cdp] Closed ${closedCount} inactive connection(s)`);

        // If no connections remain and Chrome is running, kill Chrome
        if (!connectionManager.hasConnections() && chromeLauncher.isRunning()) {
          console.error('[llm-cdp] No active connections, killing Chrome...');
          await chromeLauncher.kill();
        }
      }
    } catch (error) {
      console.error(`[llm-cdp] Error during cleanup: ${error}`);
    }
  }, CLEANUP_INTERVAL);

  // Cleanup function for graceful shutdown
  let isCleaningUp = false;
  const cleanup = async (signal: string) => {
    if (isCleaningUp) {
      return; // Prevent multiple cleanup calls
    }
    isCleaningUp = true;

    console.error(`[llm-cdp] Received ${signal}, cleaning up...`);

    try {
      clearInterval(cleanupInterval); // Stop periodic cleanup
      await connectionManager.closeAll();
      sourceMapHandler.clear();
      await chromeLauncher.kill();
      await portReserver.release();
      console.error('[llm-cdp] Cleanup complete');
    } catch (error) {
      console.error(`[llm-cdp] Cleanup error: ${error}`);
    }

    process.exit(0);
  };

  // Handle various termination signals
  process.on('SIGINT', () => cleanup('SIGINT'));   // Ctrl+C
  process.on('SIGTERM', () => cleanup('SIGTERM')); // Graceful shutdown (systemd, Docker, etc.)
  process.on('SIGHUP', () => cleanup('SIGHUP'));   // Terminal hangup

  // Handle normal exit (catch-all)
  process.on('exit', () => {
    if (!isCleaningUp) {
      console.error('[llm-cdp] Process exiting');
    }
  });
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
