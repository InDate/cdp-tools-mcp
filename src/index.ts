#!/usr/bin/env node

// Early stderr logging for debugging startup issues
console.error(`[cdp-tools] Process starting (PID: ${process.pid})`);

// Capture startup time immediately before any imports
const STARTUP_TIME = performance.now();

/**
 * cdp-tools-mcp
 * MCP server providing Chrome DevTools Protocol debugging capabilities to AI assistants
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
import { ClickableCache } from './clickable-cache.js';
import { CommandRecorder } from './command-recorder.js';
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
import { createRequestTools } from './tools/request-tools.js';
import { createModalTools } from './tools/modal-tools.js';
import { createReplayTools } from './tools/replay-tools.js';
import { createServerTools } from './tools/server-tools.js';
import { createConfigTools } from './tools/config-tools.js';
import { createPluginTools } from './tools/plugin-tools.js';
import { createIssuesTools } from './tools/issues-tools.js';
import { createDashboardTools, setDashboardInstance, getDashboardInstance, setSessionInfo, getDuplicateSessionInfo } from './tools/dashboard-tools.js';
import { initializeDashboard, shutdownDashboard, type DashboardInstance, type ConnectionInfo as DashboardConnectionInfo } from './dashboard/index.js';
import { Orchestrator } from './log-processor/orchestrator.js';
import { mkdirSync } from 'fs';
import { ServerManager } from './server-manager.js';
import { configManager } from './config.js';
import { checkPortFailures, checkBreakpointPause, checkBugBlocking, checkPendingStartups, checkDuplicateSession, prependToResponse, appendToResponse, buildStatusSuffix, type StatusLineItem } from './tool-response.js';
import { createSuccessResponse, createErrorResponse, formatCodeBlock, getMessage, getFormattedResponse } from './messages.js';
import { setChromeLauncher } from './error-helpers.js';
import { createServer } from 'net';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { debugLog, enableDebugLogging, disableDebugLogging, isDebugEnabled, enableHistoryLogging, disableHistoryLogging, setStartupMetrics } from './debug-logger.js';
import { validateReference, requireValidReference, UNNAMED_CONNECTION, InvalidReferenceError } from './reference-validator.js';
import { initializePaths, getOutputPath } from './helpers/paths.js';
import { cleanupStaleTempFiles, cleanupStaleTempFilesSync } from './atomic-write.js';
import { createSessionDetector, type SessionInfo, type SessionDetector } from './session-detector.js';

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
      console.error(`[cdp-tools] findAvailablePort: Port ${port} is available`);
      server.close(() => resolve(port));
    });

    server.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        // Port in use, try next one
        console.error(`[cdp-tools] findAvailablePort: Port ${startPort} is in use, trying ${startPort + 1}`);
        resolve(findAvailablePort(startPort + 1));
      } else {
        reject(err);
      }
    });
  });
}

/**
 * Find starting port from environment variable or auto-assign
 */
async function findStartingPort(): Promise<number> {
  const envPort = process.env.MCP_DEBUG_PORT;
  const startingPort = configManager.getChromeConfig().startingDebugPort;

  if (envPort) {
    const port = parseInt(envPort, 10);
    if (isNaN(port) || port < 1024 || port > 65535) {
      console.error(`Invalid MCP_DEBUG_PORT: ${envPort}. Using auto-assigned port.`);
      return findAvailablePort(startingPort);
    }
    return port;
  }

  return findAvailablePort(startingPort);
}

/**
 * Load instructions from docs/instructions.md
 */
async function loadInstructions(): Promise<string | undefined> {
  try {
    const instructionsPath = join(__dirname, '..', 'docs', 'instructions.md');
    return await readFile(instructionsPath, 'utf-8');
  } catch (error) {
    console.error('[cdp-tools] Failed to load instructions file:', error instanceof Error ? error.message : error);
    return undefined;
  }
}

// Initialize global managers
const sourceMapHandler = new SourceMapHandler();
const chromeLauncher = new ChromeLauncher();
const connectionManager = new ConnectionManager();
const logpointTracker = new LogpointExecutionTracker();
const clickableCache = new ClickableCache();
const commandRecorder = new CommandRecorder();
const portReserver = new PortReserver();
const serverManager = new ServerManager();

// Configure connection manager to kill Chrome when last connection closes
connectionManager.setChromeLauncher(chromeLauncher);

// Set ChromeLauncher reference for error-helpers (used to verify Chrome is running)
setChromeLauncher(chromeLauncher);

// Set up Chrome exit callback to clean up connections and reserve a new port
chromeLauncher.setOnExitCallback(async (event) => {
  const { port } = event;
  await debugLog('index', `Chrome exited on port ${port} (reason: ${event.reason})`);

  // Clean up all connections for the dead Chrome instance
  // Note: ChromeLauncher only launches on localhost, so this is always correct
  const connectionsToClose = connectionManager.getConnectionsForBrowser('localhost', port);
  for (const conn of connectionsToClose) {
    try {
      await connectionManager.closeConnection(conn.id);
      await debugLog('index', `Closed connection ${conn.id} after Chrome exit`);
    } catch (closeError) {
      await debugLog('index', `Failed to close connection ${conn.id}: ${closeError}`);
    }
  }

  // Reserve a new port for future launches
  try {
    const startingPort = configManager.getChromeConfig().startingDebugPort;
    const newPort = await findAvailablePort(startingPort);
    await portReserver.reserve(newPort);
    configManager.setCurrentPort(newPort);
    await debugLog('index', `Reserved new port ${newPort}`);
  } catch (error) {
    await debugLog('index', `Failed to reserve new port after Chrome exit: ${error}`);
  }
});

/**
 * Create and configure the MCP server with instructions
 */
async function createMCPServer(): Promise<Server> {
  const instructions = await loadInstructions();

  return new Server(
    {
      name: 'cdp-tools-debugger',
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
    'Launch Chrome with debugging',
    z.object({
      url: z.string().optional().describe('URL to open (default: blank page)'),
      autoConnect: z.boolean().optional().default(true).describe('Automatically connect debugger after launch'),
      port: z.number().optional().describe('The debugging port (optional, defaults to this session\'s reserved port). Use this to launch multiple Chrome instances on different ports.'),
      forceNewInstance: z.boolean().optional().describe('Always spawn a fresh Chrome process on a new port instead of reusing/tabbing into an existing instance'),
      headless: z.boolean().optional().default(false).describe('Launch in headless mode (no visible window, prevents focus stealing). Default: false'),
      reference: z.string().optional().describe('Connection reference name (3 descriptive words). If not provided, defaults to "unnamed-connection-default". Use this to identify the connection when calling other tools.'),
      width: z.number().optional().describe('Viewport width in pixels (optional). If set, the browser viewport will be resized after launch.'),
      height: z.number().optional().describe('Viewport height in pixels (optional). If set, the browser viewport will be resized after launch.'),
      chromeArgs: z.array(z.string()).optional().describe('Extra Chrome command-line flags to pass through at launch, e.g. ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]. Merged after the managed defaults. The CDP_TOOLS_EXTRA_CHROME_ARGS env var (space-separated) is also always merged. Only applies when this call actually launches Chrome (ignored when an existing instance on the port is reused).'),
    }).strict(),
    async (args) => {
      // Validate reference FIRST, before launching Chrome
      const userReference = args.reference;
      if (userReference) {
        requireValidReference(userReference); // Throws InvalidReferenceError if invalid
      }

      // Use reserved port unless explicitly specified
      let port = args.port || configManager.getCurrentPort();
      if (args.forceNewInstance) {
        // Ignore any reserved/requested port - always find a genuinely free one
        // so this launch can't tab into an already-running instance
        port = await findAvailablePort(configManager.getChromeConfig().startingDebugPort);
      }
      await debugLog('index', `launchChrome called: port=${port}, requested=${args.port}, reserved=${configManager.getCurrentPort()}, forceNewInstance=${args.forceNewInstance}, url=${args.url}, autoConnect=${args.autoConnect}, reference=${args.reference}`);
      const url = args.url;
      const autoConnect = args.autoConnect ?? true;

      // Check if a connection with this reference already exists - reuse it instead of creating a new tab
      // Use validated lookup to auto-cleanup dead connections (e.g., if Chrome was killed externally)
      // Skipped entirely when forceNewInstance is set - that always wants a fresh process
      if (userReference && !args.forceNewInstance) {
        const existingConnection = await connectionManager.findConnectionByReferenceValidated(userReference);
        if (existingConnection) {
          const sanitizedRef = validateReference(userReference).sanitized!;
          await debugLog('index', `Connection with reference "${sanitizedRef}" already exists, reusing`);

          // Set as active connection
          connectionManager.setActiveConnection(existingConnection.id);
          updateActiveManagers(existingConnection.id);

          // Get current page info
          let title = 'Unknown';
          let pageUrl = 'about:blank';
          if (existingConnection.puppeteerManager) {
            const page = existingConnection.puppeteerManager.getPage();
            pageUrl = page.url();
            title = await page.title();
          }

          return createSuccessResponse('CHROME_CONNECTION_REUSED', {
            reference: sanitizedRef,
            title,
            url: pageUrl
          });
        }
      }

      try {
        // Check if Chrome is already running on this port
        // We check both connectionManager (tracked connections) and chromeLauncher (actual process)
        // This handles the case where a tab was closed but Chrome is still running
        const browserAlreadyExists = connectionManager.hasBrowser('localhost', port) || chromeLauncher.isRunning(port);
        await debugLog('index', `browserAlreadyExists: ${browserAlreadyExists} (hasBrowser: ${connectionManager.hasBrowser('localhost', port)}, isRunning: ${chromeLauncher.isRunning(port)})`);
        let isNewBrowser = false;

        if (!browserAlreadyExists) {
          await debugLog('index', `Launching new Chrome instance on port ${port}...`);
          // Launch new Chrome instance (will release port reservation)
          // Don't pass URL to launch if auto-connect is enabled - let Puppeteer handle navigation
          // This prevents race condition where Chrome starts loading before monitors are set up
          const launchUrl = autoConnect ? undefined : url;
          const result = await chromeLauncher.launch(port, launchUrl, portReserver, args.headless, args.chromeArgs ?? []);
          await debugLog('index', `Chrome launched successfully: ${JSON.stringify(result)}`);
          isNewBrowser = true;
        }

        // Auto-connect if requested
        let connectionId: string | undefined;
        let runtimeType: string | undefined;
        let title = 'New Tab';
        let pageUrl = 'about:blank';
        let consoleStats = '';
        let viewportSet: { width: number; height: number } | undefined;

        if (autoConnect) {
          try {
            // Chrome is already ready (launch() waits for port binding)
            // Add small delay for new browser to ensure full initialization
            if (isNewBrowser) {
              await debugLog('index', `Waiting 500ms for new Chrome browser to stabilize...`);
              await new Promise(resolve => setTimeout(resolve, 500));
            }

            // Create connection managers for this tab
            const cdpManager = new CDPManager(sourceMapHandler);
            const puppeteerManager = new PuppeteerManager();
            const consoleMonitor = new ConsoleMonitor();
            const networkMonitor = new NetworkMonitor();

            // For existing browser, connect Puppeteer first and create/reuse a tab
            // This ensures we have a target to connect CDP to (handles case where all tabs were closed)
            let targetId: string | undefined;
            if (browserAlreadyExists) {
              await debugLog('index', `Browser exists, connecting Puppeteer and creating new tab first...`);
              await puppeteerManager.connect('localhost', port);

              // Get all existing pages
              const existingPages = await puppeteerManager.getPages();
              await debugLog('index', `Found ${existingPages.length} existing pages`);

              // Create a new page for this connection
              const page = await puppeteerManager.newPage();

              // Close any existing blank pages to avoid clutter
              for (const existingPage of existingPages) {
                try {
                  const pageUrl = existingPage.url();
                  if (pageUrl === 'about:blank' || pageUrl === 'chrome://newtab/') {
                    await debugLog('index', `Closing blank page: ${pageUrl}`);
                    await existingPage.close();
                  }
                } catch (e) {
                  // Page might already be closed, ignore
                }
              }

              // Get the target ID of the new page so we can connect CDP to it specifically
              const target = page.target();
              targetId = (target as any)._targetId || (target as any)._targetInfo?.targetId;
              await debugLog('index', `Created new tab with targetId: ${targetId}`);
            }

            // Connect to CDP (with specific target if we created a new tab)
            await cdpManager.connect('localhost', port, targetId);
            runtimeType = cdpManager.getRuntimeType();

            // Set up pause/resume callbacks to control port monitoring
            const portMonitor = serverManager.getPortMonitor();
            cdpManager.setPauseCallback(() => portMonitor.pauseMonitoring());
            cdpManager.setResumeCallback(() => portMonitor.resumeMonitoring());

            // Connect Puppeteer for Chrome (if not already connected)
            if (runtimeType === 'chrome' && !browserAlreadyExists) {
              await puppeteerManager.connect('localhost', port);
            }

            if (runtimeType === 'chrome') {

              // Start monitoring console and network
              const page = puppeteerManager.getPage();
              consoleMonitor.startMonitoring(page);
              networkMonitor.startMonitoring(page);

              // Register logpoint tracker callback on this connection's console monitor
              consoleMonitor.onMessage((message) => {
                logpointTracker.handleConsoleMessage(message);
              });

              // Set viewport dimensions if specified
              if (args.width !== undefined || args.height !== undefined) {
                const currentViewport = page.viewport() || { width: 800, height: 600 };
                const newViewport = {
                  width: args.width ?? currentViewport.width,
                  height: args.height ?? currentViewport.height,
                };
                await page.setViewport(newViewport);
                viewportSet = newViewport;
                await debugLog('index', `Set viewport to ${newViewport.width}x${newViewport.height}`);
              }

              // Navigate to URL if provided
              if (url) {
                await debugLog('index', `Navigating to URL: ${url}`);
                await page.goto(url, { waitUntil: 'load', timeout: 30000 });
                await debugLog('index', `Navigation to ${url} completed`);
              }

              // Auto-reload page to capture initial console logs (only if not navigating and has content)
              const currentUrl = page.url();
              if (!url && currentUrl && currentUrl !== 'about:blank') {
                try {
                  await page.reload({ waitUntil: 'load', timeout: 5000 });
                  await new Promise(resolve => setTimeout(resolve, 500));
                } catch (reloadError: any) {
                  console.error(`[cdp-tools] Warning: Page reload failed: ${reloadError.message}`);
                }
              }
            }

            // Get page index for tracking
            const pages = await puppeteerManager.getPages();
            const currentPage = puppeteerManager.getPage();
            const pageIndex = pages.findIndex(p => p === currentPage);

            // Register connection with user-provided reference or default
            // Reference was already validated at the start of the handler
            let connectionReference = UNNAMED_CONNECTION;
            if (userReference) {
              // Use the sanitized version (lowercase with hyphens)
              const validation = validateReference(userReference);
              connectionReference = validation.sanitized!;
            }

            connectionId = connectionManager.createConnection(
              cdpManager,
              puppeteerManager,
              consoleMonitor,
              networkMonitor,
              'localhost',
              port,
              connectionReference,
              pageIndex
            );

            // Update active manager references
            updateActiveManagers(connectionId);

            // Get page info for Chrome connections
            if (runtimeType === 'chrome') {
              const page = puppeteerManager.getPage();
              pageUrl = page.url();
              title = await page.title();

              // Get console stats and update cursor so first tool call doesn't re-report these
              const logStats = consoleMonitor.getLogStats();
              if (logStats.totalMessages > 0) {
                const details: string[] = [];
                const errorCount = logStats.newErrors;
                const warnCount = logStats.newWarnings;
                const otherCount = logStats.totalMessages - errorCount - warnCount;
                if (errorCount > 0) details.push(`${errorCount} err`);
                if (warnCount > 0) details.push(`${warnCount} warn`);
                if (otherCount > 0) details.push(`${otherCount} log`);
                consoleStats = `\n**Console:** ${details.join('/')}`;
              }
            }
          } catch (connectError) {
            // Log the auto-connect failure
            await debugLog('index', `Auto-connect failed: ${connectError}`);

            // If auto-connect fails, return detailed error
            const errorMessage = connectError instanceof Error ? connectError.message : String(connectError);
            return createSuccessResponse('CHROME_LAUNCH_AUTO_CONNECT_FAILED', {
              port: port.toString(),
              error: errorMessage,
              suggestion: 'Chrome launched but auto-connect failed. Try manually connecting with connectDebugger().'
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

          return createSuccessResponse('CHROME_LAUNCH_SUCCESS', {
            reference,
            title: title || '(no title)',
            url: pageUrl,
            consoleStats: consoleStats || undefined,
            hasUserReference: !!userReference,
            viewport: viewportSet,
          });
        } else {
          return createSuccessResponse('CHROME_LAUNCH_NO_CONNECT', { port: port.toString() }, { port, isNewBrowser });
        }
      } catch (error) {
        return createErrorResponse('CHROME_SPAWN_FAILED', { error: `${error}` });
      }
    }
  ),

  killChrome: createTool(
    'Kill Chrome process',
    z.object({
      reason: z.string().describe('Why Chrome needs to be killed'),
      port: z.number().optional().describe('Port of specific Chrome instance to kill. If not provided, kills all Chrome instances.'),
    }).strict(),
    async (args) => {
      try {
        const port = args.port;
        await debugLog('index', `killChrome called - reason: ${args.reason}, port: ${port ?? 'all'}`);

        // Set the close reason before killing (used for close event tracking)
        if (port !== undefined) {
          chromeLauncher.setPendingCloseReason(port, 'manual');
        } else {
          for (const p of chromeLauncher.getRunningPorts()) {
            chromeLauncher.setPendingCloseReason(p, 'manual');
          }
        }

        // Kill Chrome - the exit callback handles connection cleanup and port re-reservation
        await chromeLauncher.kill(port);

        return createSuccessResponse('CHROME_KILLED', {
          port: port ?? 'all',
          reason: args.reason
        });
      } catch (error) {
        return createErrorResponse('CHROME_KILL_FAILED', { error: `${error}` });
      }
    }
  ),

  resetChromeLauncher: createTool(
    'Reset Chrome launcher',
    z.object({
      reason: z.string().describe('Why Chrome launcher needs to be reset'),
    }).strict(),
    async (args) => {
      // Log the reason for audit purposes
      console.error(`[cdp-tools] resetChromeLauncher called - Reason: ${args.reason}`);
      chromeLauncher.reset();
      return createSuccessResponse('CHROME_LAUNCHER_RESET');
    }
  ),

  getChromeStatus: createTool(
    'Get Chrome status',
    z.object({}).strict(),
    async () => {
      const status = chromeLauncher.getStatus();
      // Format for template rendering
      const formattedStatus = {
        ...status,
        lastCloseEvents: status.lastCloseEvents.map(event => ({
          ...event,
          timestamp: event.timestamp.toISOString(),
          hasExitCode: event.exitCode !== null && event.exitCode !== undefined,
        })),
      };
      return createSuccessResponse('CHROME_STATUS', formattedStatus, status);
    }
  ),

  setDebugLogging: createTool(
    'Toggle debug logging',
    z.object({
      enabled: z.boolean().describe('Set to true to enable debug logging, false to disable'),
    }).strict(),
    async (args) => {
      if (args.enabled) {
        await enableDebugLogging(); // Now async to log startup metrics
        return createSuccessResponse('DEBUG_LOGGING_ENABLED', {
          message: 'Debug logging enabled. Logs will be written to .cdp-tools/logs/debug.log'
        }, {
          enabled: true,
          message: 'Debug logging enabled. Logs will be written to .cdp-tools/logs/debug.log'
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
    'Check debug logging status',
    z.object({}).strict(),
    async () => {
      const enabled = isDebugEnabled();
      return createSuccessResponse('DEBUG_LOGGING_STATUS', {
        status: enabled ? 'enabled' : 'disabled',
        enabled,  // Pass boolean for conditionals
        logFile: '.cdp-tools/logs/debug.log'
      }, {
        enabled,
        logFile: '.cdp-tools/logs/debug.log'
      });
    }
  ),

  connectDebugger: createTool(
    'Connect to debugger',
    z.object({
      reference: z.string().describe('3 descriptive words describing this debugging activity'),
      host: z.string().optional().default('localhost').describe('The debugger host (default: localhost)'),
      port: z.number().optional().describe('The debugger port (optional, defaults to this session\'s auto-assigned port). Use this to connect to debuggers on different ports (e.g., Node.js on 9229, Chrome on 9222).'),
    }).strict(),
    async (args) => {
      // Validate reference
      // Validate and get sanitized reference (throws if invalid)
      const reference = requireValidReference(args.reference);

      // Check for duplicate reference - use validated lookup to auto-cleanup dead connections
      const existingConnection = await connectionManager.findConnectionByReferenceValidated(reference);
      if (existingConnection) {
        return createErrorResponse('REFERENCE_IN_USE', {
          reference
        });
      }

      const host = args.host || 'localhost';
      const port = args.port || configManager.getCurrentPort();
      const defaultPort = configManager.getCurrentPort();
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

        // Set up pause/resume callbacks to control port monitoring
        const portMonitor = serverManager.getPortMonitor();
        cdpManager.setPauseCallback(() => portMonitor.pauseMonitoring());
        cdpManager.setResumeCallback(() => portMonitor.resumeMonitoring());

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
              console.error(`[cdp-tools] Warning: Page reload failed: ${reloadError.message}`);
            }
          }

          features.push('browser-automation', 'console-monitoring', 'network-monitoring');
        } else {
          // For Node.js debugging, set up console monitoring via CDP Runtime.consoleAPICalled
          // Set up value expander to get full object details (passes maxDepth from consoleMonitor)
          consoleMonitor.setValueExpander((objectId, maxDepth) => cdpManager.expandObjectById(objectId, maxDepth));
          cdpManager.setConsoleMessageCallback((message) => {
            consoleMonitor.addCDPConsoleMessage(message);
          });
          consoleMonitor.enableWithoutPage();
          features.push('console-monitoring');
        }

        // Register logpoint tracker callback on this connection's console monitor
        // This ensures logpoint executions are tracked for both Chrome and Node.js connections
        consoleMonitor.onMessage((message) => {
          logpointTracker.handleConsoleMessage(message);
        });

        // Get page index for tracking
        let pageIndex: number | undefined;
        if (runtimeType === 'chrome') {
          const pages = await puppeteerManager.getPages();
          const currentPage = puppeteerManager.getPage();
          pageIndex = pages.findIndex(p => p === currentPage);
        }

        // Register connection with ConnectionManager
        // Note: consoleMonitor is always passed now (works for both Chrome and Node.js)
        const connectionId = connectionManager.createConnection(
          cdpManager,
          runtimeType === 'chrome' ? puppeteerManager : undefined,
          consoleMonitor, // Always include - works for both Chrome (via Puppeteer) and Node.js (via CDP)
          runtimeType === 'chrome' ? networkMonitor : undefined,
          host,
          port,
          reference, // Set reference from parameter
          pageIndex
        );

        // Update active manager references
        updateActiveManagers(connectionId);

        // Build console stats for Chrome connections
        let consoleStats: string | undefined;
        if (runtimeType === 'chrome') {
          const connection = connectionManager.getConnection(connectionId);
          if (connection?.consoleMonitor) {
            // Get console stats and update cursor so first tool call doesn't re-report these
            const logStats = connection.consoleMonitor.getLogStats();
            if (logStats.totalMessages > 0) {
              const details: string[] = [];
              if (logStats.newErrors > 0) details.push(`${logStats.newErrors} err`);
              if (logStats.newWarnings > 0) details.push(`${logStats.newWarnings} warn`);
              const otherCount = logStats.totalMessages - logStats.newErrors - logStats.newWarnings;
              if (otherCount > 0) details.push(`${otherCount} log`);
              consoleStats = details.join('/');
            }
          }
        }

        return createSuccessResponse('DEBUGGER_CONNECT_SUCCESS', {
          runtimeType,
          host,
          port: port.toString(),
          reference,
          features: features.join(', '),
          consoleStats,
          isChrome: runtimeType === 'chrome',
          isNode: runtimeType === 'node'
        });
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
    'Disconnect debugger',
    z.object({
      reason: z.string().describe('Why the connection needs to be disconnected'),
      reference: z.string().describe('3 descriptive words of the connection to disconnect'),
    }).strict(),
    async (args) => {
      // Log the reason for audit purposes
      console.error(`[cdp-tools] disconnectDebugger called - Reason: ${args.reason}, Reference: ${args.reference}`);

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
    'Load source maps',
    z.object({
      directory: z.string().describe('The directory containing .js.map files'),
    }).strict(),
    async (args) => {
      const { directory } = args;

      try {
        const registered = await sourceMapHandler.registerSourceMapsFromDirectory(directory);

        return createSuccessResponse('SOURCE_MAPS_LOADED', {
          count: registered.toString(),
          directory
        }, { registered, note: 'Source maps registered for lazy loading (will be loaded on demand)' });
      } catch (error) {
        return createErrorResponse('SOURCE_MAPS_FAILED', { error: `${error}` });
      }
    }
  ),

  getDebuggerStatus: createTool(
    'Get debugger status',
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
    'List debugger connections',
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
    'Switch debugger connection',
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

// Session detection state (set in main, used in tool handler)
let sessionDetectorInstance: SessionDetector | null = null;
let sessionVerifyStarted = false;

// Log processor orchestrator (set in main for hub instances)
let orchestratorInstance: Orchestrator | null = null;

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

/**
 * Execute a tool call - used by replay system
 */
async function executeToolCall(toolName: string, params: Record<string, any>): Promise<any> {
  const tool = allTools[toolName as keyof typeof allTools];

  if (!tool) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  const validation = validateParams(params, (tool as any).zodSchema, toolName);

  if (!validation.success) {
    throw new Error(`Validation failed: ${JSON.stringify(validation.error)}`);
  }

  const result = await tool.handler(validation.data);

  // If tool returned an error, throw it as a ToolError so it propagates correctly
  if (result?.isError) {
    throw new ToolError(result);
  }

  return result;
}

/**
 * Error that wraps a tool error response for propagation
 */
class ToolError extends Error {
  constructor(public response: any) {
    super(response?.content?.[0]?.text || 'Tool error');
  }
}

// Combine all tools (conditionally based on config)
const allTools = {
  // Connection tools (Chrome/debugger)
  ...(configManager.isToolEnabled('connection') ? connectionTools : {}),
  // Tab Management tools
  ...(configManager.isToolEnabled('tab') ? createTabTools(connectionManager, sourceMapHandler, updateActiveManagers, logpointTracker, serverManager) : {}),
  // CDP Debugging tools
  ...(configManager.isToolEnabled('breakpoint') ? createBreakpointTools(proxyCdpManager, sourceMapHandler, logpointTracker, resolveConnectionFromReason) : {}),
  ...(configManager.isToolEnabled('execution') ? createExecutionTools(proxyCdpManager, resolveConnectionFromReason, connectionManager) : {}),
  ...(configManager.isToolEnabled('inspection') ? createInspectionTools(proxyCdpManager, sourceMapHandler, resolveConnectionFromReason) : {}),
  ...(configManager.isToolEnabled('source') ? createSourceTools(proxyCdpManager, sourceMapHandler, resolveConnectionFromReason) : {}),
  // Browser Automation tools
  ...(configManager.isToolEnabled('console') ? createConsoleTools(proxyPuppeteerManager, proxyConsoleMonitor, resolveConnectionFromReason) : {}),
  ...(configManager.isToolEnabled('network') ? createNetworkTools(proxyPuppeteerManager, proxyNetworkMonitor, resolveConnectionFromReason) : {}),
  ...(configManager.isToolEnabled('page') ? createPageTools(proxyPuppeteerManager, proxyCdpManager, proxyConsoleMonitor, proxyNetworkMonitor, connectionManager, resolveConnectionFromReason, clickableCache, executeToolCall) : {}),
  ...(configManager.isToolEnabled('dom') ? createDOMTools(proxyPuppeteerManager, proxyCdpManager, connectionManager, resolveConnectionFromReason) : {}),
  ...(configManager.isToolEnabled('screenshot') ? createScreenshotTools(proxyPuppeteerManager, proxyCdpManager, connectionManager, resolveConnectionFromReason) : {}),
  ...(configManager.isToolEnabled('input') ? createInputTools(proxyPuppeteerManager, proxyCdpManager, connectionManager, resolveConnectionFromReason) : {}),
  ...(configManager.isToolEnabled('content') ? createContentTools(proxyPuppeteerManager, proxyCdpManager, connectionManager, resolveConnectionFromReason, clickableCache) : {}),
  ...(configManager.isToolEnabled('modal') ? createModalTools(resolveConnectionFromReason) : {}),
  ...(configManager.isToolEnabled('storage') ? createStorageTools(proxyPuppeteerManager, proxyCdpManager, resolveConnectionFromReason) : {}),
  // Download tools
  ...(configManager.isToolEnabled('download') ? createDownloadTools() : {}),
  // Request tools (HTTP requests as sequence steps, node or browser destination)
  ...(configManager.isToolEnabled('request') ? createRequestTools(resolveConnectionFromReason) : {}),
  // Replay tools
  ...(configManager.isToolEnabled('replay') ? createReplayTools(commandRecorder, executeToolCall, async (connectionReason: string) => {
    const resolved = await resolveConnectionFromReason(connectionReason);
    if (!resolved?.puppeteerManager) return null;
    return resolved.puppeteerManager.getPage();
  }, async (connectionReason: string) => {
    const resolved = await resolveConnectionFromReason(connectionReason);
    return resolved?.connection.port ?? null;
  }) : {}),
  // Server management tools
  ...(configManager.isToolEnabled('server') ? createServerTools(serverManager) : {}),
  // Config management tools (always enabled - not toggleable)
  ...createConfigTools(),
  // Plugin management tools (always enabled - not toggleable)
  ...createPluginTools(() => orchestratorInstance),
  // Issues tracking tools
  ...(configManager.isToolEnabled('issues') ? createIssuesTools(
    executeToolCall,
    async (name: string) => {
      // Helper to get sequence path by name
      const sequences = commandRecorder.listSequences();
      const sequence = sequences.find(s => s.name === name || s.id === name);
      if (!sequence) return null;
      // Try to find saved file
      const sequencesDir = commandRecorder.getSequencesDir();
      const filename = name.replace(/[^a-z0-9-_]/gi, '-').toLowerCase() + '.json';
      const { join } = await import('path');
      const { existsSync } = await import('fs');
      const filepath = join(sequencesDir, filename);
      if (existsSync(filepath)) return filepath;
      return null;
    },
    async (connectionReason: string) => {
      const resolved = await resolveConnectionFromReason(connectionReason);
      if (!resolved?.puppeteerManager) return null;
      return resolved.puppeteerManager.getPage();
    }
  ) : {}),
  // Dashboard tools (lazy-initialized in main())
  ...(configManager.isToolEnabled('dashboard') ? createDashboardTools() : {}),
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

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
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

    // Check for tool dependency conflicts (blocks ALL tools except config)
    if (toolName !== 'config' && configManager.hasDependencyConflicts()) {
      const conflicts = configManager.getDependencyConflicts();
      const configPath = configManager.getStatus().loadedFrom || '.cdp-tools/config.json';
      return {
        content: [
          {
            type: 'text',
            text: `Tool dependency conflict - all tools blocked.

${conflicts.join('\n\n')}

Edit ${configPath} to resolve, then restart the MCP server.`,
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

    // Record command if recording is active (but don't record replay tool calls)
    // Capture the command index for the repeat hint
    let commandIndex: number | null = null;
    if (toolName !== 'replay') {
      await commandRecorder.recordCommand(toolName, validation.data);
      commandIndex = commandRecorder.getCurrentHistoryIndex();
    }

    // Check for failed monitored ports
    const portMonitor = serverManager.getPortMonitor();
    const failedPorts = portMonitor.getFailedPorts();
    const portCheck = checkPortFailures(failedPorts, toolName);

    if (portCheck.blocked) {
      return portCheck.response;
    }

    // Check for breakpoint pauses (block tools until acknowledged or resumed)
    const allConnections = connectionManager.getAllConnections();
    const breakpointCheck = checkBreakpointPause(allConnections, toolName);

    if (breakpointCheck.blocked) {
      return breakpointCheck.response;
    }

    // Check for pending startup failures (block tools until acknowledged)
    const pendingStartupFailures = serverManager.getPendingStartupFailures();
    const pendingStartupCheck = checkPendingStartups(pendingStartupFailures, toolName);

    if (pendingStartupCheck.blocked) {
      return pendingStartupCheck.response;
    }

    // Check for blocking bugs from recordings
    const bugCheck = await checkBugBlocking(toolName, validation.data as Record<string, unknown>);
    if (bugCheck.blocked) {
      return bugCheck.response;
    }

    // Check for duplicate session (multiple MCPs for same Claude session)
    const duplicateInfo = getDuplicateSessionInfo();
    const duplicateCheck = checkDuplicateSession(duplicateInfo, toolName);
    if (duplicateCheck.blocked) {
      return duplicateCheck.response;
    }

    // Pass validated data to handler
    try {
      const result = await tool.handler(validation.data, extra?.signal);

      // Prepend port failure prefix if any
      if (portCheck.prefix) {
        prependToResponse(result, portCheck.prefix);
        if (portCheck.markAsError) {
          result.isError = true;
        }
      }

      // Prepend breakpoint pause prefix if any (for allowed tools when paused)
      if (breakpointCheck.prefix) {
        prependToResponse(result, breakpointCheck.prefix);
      }

      // Collect status lines to append to response
      const statusItems: StatusLineItem[] = [];


      // Append server log status to all tool responses
      const serverLogStats = serverManager.getLogStats();
      if (serverLogStats.length > 0) {
        const parts = serverLogStats
          .filter(s => s.newStderr > 0 || s.newStdout > 0)
          .map(s => `${s.serverId} (${s.newStderr} err/${s.newStdout} out)`);

        if (parts.length > 0) {
          statusItems.push({ label: 'Server Logs', value: parts.join(' | ') });
        }
      }

      // Append console log status if tool used a connectionReason
      const connectionReason = validation.data?.connectionReason;
      if (connectionReason) {
        const connection = connectionManager.findConnectionByReference(connectionReason);
        if (connection?.consoleMonitor) {
          const logStats = connection.consoleMonitor.getLogStats();
          if (logStats.newMessages > 0) {
            const details: string[] = [];
            if (logStats.newErrors > 0) details.push(`${logStats.newErrors} err`);
            if (logStats.newWarnings > 0) details.push(`${logStats.newWarnings} warn`);
            const otherCount = logStats.newMessages - logStats.newErrors - logStats.newWarnings;
            if (otherCount > 0) details.push(`${otherCount} log`);
            statusItems.push({ label: 'Console', value: details.join('/') });
          }
        }
      }

      // Add replay hint with history index
      if (commandIndex !== null) {
        statusItems.push({
          label: 'Repeat',
          value: `\`replay({ action: 'repeat', indices: [${commandIndex}] })\``
        });
      }

      // Append all status lines if any
      const statusSuffix = buildStatusSuffix(statusItems);
      if (statusSuffix) {
        appendToResponse(result, statusSuffix);
      }

      // Always append PID for session file verification
      // This gets logged by Claude, allowing us to identify our session file
      // See: src/session-detector.ts for how this is used
      appendToResponse(result, `\npid:${process.pid}`);

      // Report action to dashboard (if enabled)
      const dashboardInst = getDashboardInstance();
      if (dashboardInst) {
        if (dashboardInst.hub) {
          // We're the hub - update our own state
          const connections = connectionManager.getAllConnections().map(conn => ({
            reference: conn.reference || conn.id,
            type: conn.type,
            state: conn.cdpManager.isPaused() ? 'paused' as const :
                   (Date.now() - conn.lastActivityAt < 30000) ? 'active' as const : 'idle' as const,
            createdAt: conn.createdAt,
            lastActivityAt: conn.lastActivityAt,
          }));
          dashboardInst.hub.updateSelf(connections, {
            tool: toolName,
            timestamp: Date.now(),
            connectionReference: connectionReason,
          });
        } else if (dashboardInst.client) {
          // We're a client - report to hub
          dashboardInst.client.reportAction(toolName, connectionReason);
        }
      }

      // Start session verification after first tool use
      // The PID we just appended to the response will be logged by Claude.
      // Now we watch session files and look for that PID to identify our session.
      if (sessionDetectorInstance && !sessionVerifyStarted) {
        sessionVerifyStarted = true;
        sessionDetectorInstance.verify(process.pid);
      }

      return result;
    } catch (error) {
      // Check for ToolError and return its response directly
      if (error instanceof ToolError) {
        return error.response;
      }

      // Check for InvalidReferenceError and return its formatted response
      if (error instanceof InvalidReferenceError) {
        return error.response;
      }

      return {
        content: [
          {
            type: 'text',
            text: error instanceof Error ? error.message : `${error}`,
          },
        ],
        isError: true
      };
    }
  });
}

// Start the server
async function main() {
  console.error(`[cdp-tools] main() called (PID: ${process.pid})`);

  // Initialize path configuration early (before any file operations)
  const pathConfig = initializePaths();
  console.error(`[cdp-tools] Path config: global=${pathConfig.globalBase}, workingDir=${pathConfig.workingDirBase ?? 'none (using global fallback)'}`);

  // Clean up stale temp files from previous crashed/killed processes
  // Run in background - don't block startup
  Promise.all([
    cleanupStaleTempFiles(pathConfig.globalBase),
    pathConfig.workingDirBase ? cleanupStaleTempFiles(pathConfig.workingDirBase) : Promise.resolve({ cleaned: [], errors: [] })
  ]).then(([globalResult, localResult]) => {
    const totalCleaned = globalResult.cleaned.length + localResult.cleaned.length;
    if (totalCleaned > 0) {
      console.error(`[cdp-tools] Cleaned ${totalCleaned} stale temp file(s)`);
    }
  }).catch(() => {
    // Ignore cleanup errors - best effort only
  });

  // Start non-blocking session detection (polls for file modified after MCP start)
  const cwd = process.cwd();
  const mcpStartTime = Date.now();
  // SessionInfo detected asynchronously - may be undefined until callback fires
  let detectedSessionInfo: SessionInfo | undefined;
  // Dashboard instance - initialized after session is detected
  let dashboardInstance: DashboardInstance | null = null;

  // Set up session detector (starts monitoring immediately)
  sessionDetectorInstance = createSessionDetector(cwd);

  // Helper to convert connections to dashboard format
  const getConnectionsForDashboard = (): DashboardConnectionInfo[] => {
    return connectionManager.getAllConnections().map(conn => ({
      reference: conn.reference || conn.id,
      type: conn.type,
      state: conn.cdpManager.isPaused() ? 'paused' as const :
             (Date.now() - conn.lastActivityAt < 30000) ? 'active' as const : 'idle' as const,
      createdAt: conn.createdAt,
      lastActivityAt: conn.lastActivityAt,
    }));
  };

  const sessionStartTime = Date.now() - (performance.now() - STARTUP_TIME);

  // Helper to start orchestrator when becoming hub
  const startOrchestrator = async (hub: NonNullable<DashboardInstance['hub']>) => {
    if (orchestratorInstance || !sessionDetectorInstance) return;

    try {
      const configDir = join(cwd, '.cdp-tools', 'config');
      mkdirSync(join(configDir, 'classifiers'), { recursive: true });
      mkdirSync(join(configDir, 'extractors'), { recursive: true });
      mkdirSync(join(configDir, 'state-machines'), { recursive: true });
      mkdirSync(join(configDir, 'dashboard'), { recursive: true });

      orchestratorInstance = new Orchestrator({
        source: {
          mode: 'live',
          sessionDetector: sessionDetectorInstance
        },
        configDir
      });

      await orchestratorInstance.start();
      hub.connectLogProcessor(orchestratorInstance);

      // Start custom dashboard route loader
      const dashboardConfigDir = join(configDir, 'dashboard');
      await hub.startRouteLoader(dashboardConfigDir);

      await debugLog('log-processor', 'Orchestrator started and connected to dashboard hub');
    } catch (error) {
      await debugLog('log-processor', `Failed to start orchestrator: ${error}`);
    }
  };

  // Failover callback - when hub dies, try to become the new hub
  const handleHubDown = async () => {
    await debugLog('dashboard', 'Attempting to become new hub...');
    const currentSession = detectedSessionInfo;
    const newInstance = await initializeDashboard(
      process.cwd(),
      sessionStartTime,
      getConnectionsForDashboard,
      currentSession?.sessionId || `pid-${process.pid}`,
      currentSession?.shortId || `pid-${process.pid}`,
      handleHubDown  // Pass callback again for the new client
    );
    if (newInstance) {
      dashboardInstance = newInstance;
      setDashboardInstance(newInstance);
      await debugLog('dashboard', `Failover: now ${newInstance.type} on port ${newInstance.port}`);

      // If we became the hub, start the orchestrator
      if (newInstance.hub) {
        await startOrchestrator(newInstance.hub);
      }
    }
  };

  // Initialize dashboard immediately (don't wait for session detection)
  if (configManager.isToolEnabled('dashboard')) {
    dashboardInstance = await initializeDashboard(
      process.cwd(),
      sessionStartTime,
      getConnectionsForDashboard,
      `pid-${process.pid}`,  // Placeholder until session detected
      `pid-${process.pid}`,
      handleHubDown
    );

    if (dashboardInstance) {
      setDashboardInstance(dashboardInstance);
      await debugLog('dashboard', `Initialized as ${dashboardInstance.type} on port ${dashboardInstance.port}`);
    } else {
      await debugLog('dashboard', `Initialization failed`);
    }
  }

  // Subscribe to session changes - update session info when detected
  sessionDetectorInstance.session$.subscribe(async (sessionInfo) => {
    await debugLog('session-detector', `Session ID: ${sessionInfo.shortId} (${sessionInfo.sessionId})`);
    detectedSessionInfo = sessionInfo;
    setSessionInfo(sessionInfo);

    // Update dashboard with real session info
    await debugLog('dashboard', `Updating session info: instance=${!!dashboardInstance}, hub=${!!dashboardInstance?.hub}, client=${!!dashboardInstance?.client}`);
    if (dashboardInstance?.hub) {
      dashboardInstance.hub.updateSessionInfo(sessionInfo.sessionId, sessionInfo.shortId);
      await debugLog('dashboard', `Hub session info updated to ${sessionInfo.shortId}`);
    } else if (dashboardInstance?.client) {
      dashboardInstance.client.updateSessionInfo(sessionInfo.sessionId, sessionInfo.shortId);
      await debugLog('dashboard', `Client session info updated to ${sessionInfo.shortId}`);
    }
  });

  // Subscribe to entry count changes - update dashboard
  sessionDetectorInstance.entryCount$.subscribe(async (count) => {
    if (dashboardInstance?.hub) {
      dashboardInstance.hub.updateSessionEntryCount(count);
    } else if (dashboardInstance?.client) {
      dashboardInstance.client.updateSessionEntryCount(count);
    }
  });

  // Load configuration early so debug logging is available for orchestrator startup
  await configManager.load();
  const debugConfig = configManager.getDebugConfig();
  if (debugConfig.enabled) {
    await enableDebugLogging({ clearOnStartup: true });
  }
  if (debugConfig.historyLogEnabled) {
    enableHistoryLogging();
  }

  // Initialize log processor orchestrator (hub only)
  if (dashboardInstance?.hub) {
    await startOrchestrator(dashboardInstance.hub);
  }

  // Capture import time (time from script start to main() being called)
  const importTime = performance.now() - STARTUP_TIME;

  // Initialize and reserve debug port with retry logic
  const portReservationStart = performance.now();
  let reservationSucceeded = false;
  let attempts = 0;
  const maxAttempts = 10;

  while (!reservationSucceeded && attempts < maxAttempts) {
    const port = await findStartingPort();
    configManager.setCurrentPort(port);

    // Reserve the port by binding a socket to it
    try {
      await portReserver.reserve(port);
      console.error(`[cdp-tools] Reserved debug port: ${port}`);
      reservationSucceeded = true;
    } catch (error) {
      attempts++;
      console.error(`[cdp-tools] Port ${port} reservation failed (attempt ${attempts}/${maxAttempts}), trying next port...`);

      if (attempts >= maxAttempts) {
        console.error(`[cdp-tools] Failed to reserve a port after ${maxAttempts} attempts`);
        process.exit(1);
      }

      // Try the next port
      process.env.MCP_DEBUG_PORT = String(port + 1);
    }
  }

  const portReservationTime = performance.now() - portReservationStart;

  // Create server with instructions
  const serverCreationStart = performance.now();
  const server = await createMCPServer();
  const serverCreationTime = performance.now() - serverCreationStart;

  // Register tool handlers
  const toolRegistrationStart = performance.now();
  registerToolHandlers(server);
  const toolRegistrationTime = performance.now() - toolRegistrationStart;

  // Connect to transport
  console.error(`[cdp-tools] Connecting to transport (PID: ${process.pid})`);
  const transportStart = performance.now();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const transportTime = performance.now() - transportStart;
  console.error(`[cdp-tools] Transport connected (PID: ${process.pid})`);

  // Note: Config was already loaded earlier (before orchestrator startup) for debug logging

  // Initialize server manager - recover running servers and start auto-run servers
  const serverInitResult = await serverManager.initialize();
  if (serverInitResult.recovered.length > 0) {
    console.error(`[cdp-tools] Recovered ${serverInitResult.recovered.length} running server(s): ${serverInitResult.recovered.join(', ')}`);
  }
  if (serverInitResult.started.length > 0) {
    console.error(`[cdp-tools] Auto-started ${serverInitResult.started.length} server(s): ${serverInitResult.started.join(', ')}`);
  }
  if (serverInitResult.failed.length > 0) {
    console.error(`[cdp-tools] Failed to auto-start ${serverInitResult.failed.length} server(s): ${serverInitResult.failed.join(', ')}`);
  }

  // Dashboard is initialized in session detection callback after sessionId is known

  console.error(`[cdp-tools] Server ready (PID: ${process.pid})`);

  // Calculate total startup time and store metrics for later logging
  const totalStartupTime = performance.now() - STARTUP_TIME;
  setStartupMetrics({
    totalMs: Math.round(totalStartupTime),
    importMs: Math.round(importTime),
    portReservationMs: Math.round(portReservationTime),
    portAttempts: attempts + 1,
    serverCreationMs: Math.round(serverCreationTime),
    toolRegistrationMs: Math.round(toolRegistrationTime),
    transportMs: Math.round(transportTime),
    capturedAt: new Date().toISOString(),
  });

  // Start periodic cleanup of inactive connections
  const chromeConfig = configManager.getChromeConfig();
  const CLEANUP_INTERVAL = chromeConfig.inactivityPollingMinutes * 60 * 1000;
  const INACTIVITY_THRESHOLD = chromeConfig.inactivityTimeoutMinutes * 60 * 1000;

  // Only start cleanup interval if inactivity timeout is enabled (> 0)
  const cleanupInterval = INACTIVITY_THRESHOLD > 0 ? setInterval(async () => {
    try {
      const inactiveConnections = connectionManager.getInactiveConnections(INACTIVITY_THRESHOLD);
      if (inactiveConnections.length > 0) {
        await debugLog('index', `Found ${inactiveConnections.length} inactive connection(s) to close`);
        for (const conn of inactiveConnections) {
          await debugLog('index', `Closing inactive connection: ${conn.id} (inactive for ${Math.round(conn.inactiveForMs / 1000)}s)`);
        }
      }

      const closedCount = await connectionManager.closeInactiveConnections(INACTIVITY_THRESHOLD);
      if (closedCount > 0) {
        console.error(`[cdp-tools] Closed ${closedCount} inactive connection(s)`);
        await debugLog('index', `Closed ${closedCount} inactive connection(s)`);

        // If no connections remain and Chrome is running, check for browser activity before killing
        if (!connectionManager.hasConnections() && chromeLauncher.isRunning()) {
          // Check if there's been recent browser activity (network requests, console messages)
          // This prevents killing Chrome when user is actively browsing
          let hasBrowserActivity = false;

          // Check all connections for recent activity
          for (const conn of connectionManager.getAllConnections()) {
            if (conn.networkMonitor?.hasRecentActivity(INACTIVITY_THRESHOLD)) {
              hasBrowserActivity = true;
              await debugLog('index', `Connection ${conn.id} has recent network activity, skipping Chrome kill`);
              break;
            }
            if (conn.consoleMonitor?.hasRecentActivity(INACTIVITY_THRESHOLD)) {
              hasBrowserActivity = true;
              await debugLog('index', `Connection ${conn.id} has recent console activity, skipping Chrome kill`);
              break;
            }
          }

          if (hasBrowserActivity) {
            await debugLog('index', `Browser has recent activity, not killing Chrome`);
          } else {
            const runningPorts = chromeLauncher.getRunningPorts();
            console.error('[cdp-tools] No active connections or browser activity, killing Chrome due to inactivity...');
            await debugLog('index', `No active connections or browser activity, killing Chrome on ports: ${runningPorts.join(', ')} due to inactivity`);

            // Set the close reason before killing
            for (const port of runningPorts) {
              chromeLauncher.setPendingCloseReason(port, 'inactivity');
              await debugLog('index', `Set pending close reason 'inactivity' for port ${port}`);
            }
            await chromeLauncher.kill();
            await debugLog('index', `Chrome killed due to inactivity`);
          }
        }
      }
    } catch (error) {
      console.error(`[cdp-tools] Error during cleanup: ${error}`);
      await debugLog('index', `Error during inactivity cleanup: ${error}`);
    }
  }, CLEANUP_INTERVAL) : null;

  // Cleanup function for graceful shutdown
  let isCleaningUp = false;
  const cleanup = async (signal: string) => {
    if (isCleaningUp) {
      return; // Prevent multiple cleanup calls
    }
    isCleaningUp = true;

    console.error(`[cdp-tools] Received ${signal}, cleaning up...`);

    try {
      if (cleanupInterval) clearInterval(cleanupInterval); // Stop periodic cleanup
      await connectionManager.closeAll();
      sourceMapHandler.clear();
      await chromeLauncher.kill();
      await portReserver.release();
      // Stop session detector if running
      if (sessionDetectorInstance) {
        sessionDetectorInstance.stop();
      }
      // Stop log processor orchestrator if running
      if (orchestratorInstance) {
        orchestratorInstance.stop();
      }
      // Stop file watcher if running
      if ((dashboardInstance as any)?._stopFileWatcher) {
        (dashboardInstance as any)._stopFileWatcher();
      }
      await shutdownDashboard(dashboardInstance);

      // Final sync cleanup of temp files before exit
      const globalCleaned = cleanupStaleTempFilesSync(pathConfig.globalBase, 0);
      const localCleaned = pathConfig.workingDirBase
        ? cleanupStaleTempFilesSync(pathConfig.workingDirBase, 0)
        : { cleaned: [] };
      const totalCleaned = globalCleaned.cleaned.length + localCleaned.cleaned.length;
      if (totalCleaned > 0) {
        console.error(`[cdp-tools] Cleaned ${totalCleaned} temp file(s) on shutdown`);
      }

      console.error('[cdp-tools] Cleanup complete');
    } catch (error) {
      console.error(`[cdp-tools] Cleanup error: ${error}`);
    }

    process.exit(0);
  };

  // Handle various termination signals
  process.on('SIGINT', () => cleanup('SIGINT'));   // Ctrl+C
  process.on('SIGTERM', () => cleanup('SIGTERM')); // Graceful shutdown (systemd, Docker, etc.)
  process.on('SIGHUP', () => cleanup('SIGHUP'));   // Terminal hangup

  // Handle stdin close - this catches when the parent process (Claude Code) terminates
  // without sending a signal. MCP uses stdin/stdout for communication, so if stdin closes,
  // the parent is gone and we should clean up.
  process.stdin.on('close', () => cleanup('stdin-close'));
  process.stdin.on('end', () => cleanup('stdin-end'));

  // Handle normal exit (catch-all)
  process.on('exit', () => {
    if (!isCleaningUp) {
      console.error('[cdp-tools] Process exiting');
    }
  });

  // Catch uncaught exceptions and unhandled rejections for debugging.
  //
  // This handler must NOT re-enter the V8 inspector console path that can itself
  // throw (issue #74): a page emitting frequent `console.error` could make a
  // `console.error(error)` here re-trigger `uncaughtException` in a tight ~1ms
  // loop that saturates a CPU core forever. So we:
  //   1. write raw to stderr (no `console` / inspector hook),
  //   2. wrap all logging in try/catch (touching `error.stack` can itself throw
  //      via a custom Error.prepareStackTrace / inspector wrapper),
  //   3. dedupe and hard-exit if the SAME exception storms, as a last-resort
  //      circuit breaker.
  const writeErr = (line: string) => { try { process.stderr.write(line + '\n'); } catch { /* never crash the handler */ } };
  let lastUncaughtMsg = '';
  let lastUncaughtAt = 0;
  let uncaughtCount = 0;
  process.on('uncaughtException', (error, origin) => {
    const now = Date.now();
    const msg = (error && (error as Error).message) ? (error as Error).message : String(error);
    if (msg === lastUncaughtMsg && now - lastUncaughtAt < 1000) {
      if (++uncaughtCount > 50) {
        writeErr('[cdp-tools] Same uncaught exception >50x in <1s — exiting to break the loop.');
        process.exit(1);
      }
      return;
    }
    lastUncaughtMsg = msg;
    lastUncaughtAt = now;
    uncaughtCount = 0;
    writeErr(`[cdp-tools] UNCAUGHT EXCEPTION (${origin}): ${msg}`);
    try { const s = (error as Error)?.stack; if (s) writeErr(`[cdp-tools] Stack: ${s}`); } catch { /* stack getter can throw */ }
  });

  process.on('unhandledRejection', (reason) => {
    const msg = (reason && (reason as Error).message) ? (reason as Error).message : String(reason);
    writeErr(`[cdp-tools] UNHANDLED REJECTION: ${msg}`);
    try { const s = (reason as Error)?.stack; if (s) writeErr(`[cdp-tools] Stack: ${s}`); } catch { /* stack getter can throw */ }
  });
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
