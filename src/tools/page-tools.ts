/**
 * Page Navigation Tools
 */

import { z } from 'zod';
import type { CDPManager } from '../cdp-manager.js';
import { PuppeteerManager } from '../puppeteer-manager.js';
import { ConsoleMonitor } from '../console-monitor.js';
import { NetworkMonitor } from '../network-monitor.js';
import type { ConnectionManager } from '../connection-manager.js';
import { executeWithPauseDetection, formatActionResult } from '../debugger-aware-wrapper.js';
import { checkBrowserAutomation } from '../error-helpers.js';
import { createTool } from '../validation-helpers.js';
import { createSuccessResponse, createErrorResponse, formatCodeBlock } from '../messages.js';
import { autoLaunchChrome } from './replay-executor.js';
import type { ClickableCache, ClickableElement } from '../clickable-cache.js';
import { collectInteractiveElements } from '../element-collector.js';
import type { ToolResponseMeta, NavigateActionMeta } from '../tool-response.js';

// =============================================================================
// Types
// =============================================================================

export interface PageContext {
  url: string;
  title: string;
  clickableElements: {
    total: number;
    inViewport: number;
  };
  console: {
    errors: number;
    warnings: number;
    total: number;
  };
  network: {
    failed: number;
    total: number;
  };
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Gather page context including console errors and failed network requests
 */
export async function gatherPageContext(
  page: any,
  consoleMonitor: ConsoleMonitor,
  networkMonitor: NetworkMonitor,
  clickableCache: ClickableCache
): Promise<PageContext> {
  const url = page.url();
  const title = await page.title();

  // Get clickable elements stats
  const result = await collectInteractiveElements(page);
  clickableCache.set(url, result.elements, result.viewportHeight, result.viewportWidth);
  const inViewportCount = result.elements.filter((el) => el.inViewport).length;

  // Get console stats
  const consoleErrors = consoleMonitor.getCount('error');
  const consoleWarnings = consoleMonitor.getCount('warning');
  const consoleTotal = consoleMonitor.getCount();

  // Get network stats
  const allRequests = networkMonitor.getRequests();
  const failedRequests = allRequests.filter(r =>
    r.failed || (r.response && r.response.status >= 400)
  ).length;

  return {
    url,
    title,
    clickableElements: {
      total: result.elements.length,
      inViewport: inViewportCount,
    },
    console: {
      errors: consoleErrors,
      warnings: consoleWarnings,
      total: consoleTotal,
    },
    network: {
      failed: failedRequests,
      total: allRequests.length,
    },
  };
}

/**
 * Format page context for response
 */
export function formatPageContextForResponse(context: PageContext): Record<string, any> {
  const response: Record<string, any> = {
    url: context.url,
    title: context.title,
    clickableElements: {
      total: context.clickableElements.total,
      inViewport: context.clickableElements.inViewport,
      hint: 'Use content({ action: "findInteractive" }) to explore interactive elements',
    },
  };

  // Add console status if there are errors or warnings
  if (context.console.errors > 0 || context.console.warnings > 0) {
    response.console = {
      errors: context.console.errors,
      warnings: context.console.warnings,
      hint: context.console.errors > 0
        ? 'Use console({ action: "list", type: "error" }) to view errors'
        : undefined,
    };
  }

  // Add network status if there are failed requests
  if (context.network.failed > 0) {
    response.network = {
      failed: context.network.failed,
      total: context.network.total,
      hint: 'Use network({ action: "search", statusCode: "4" }) to view failed requests',
    };
  }

  return response;
}

// Consolidated schema for page navigation tools
const navigateSchema = z.object({
  action: z.enum(['goto', 'reload', 'back', 'forward', 'info']).describe('Page navigation action: goto (navigate to URL), reload (reload page), back (go back), forward (go forward), info (get page info)'),
  connectionReason: z.string().describe('Connection reference (use the reference from launchChrome output, e.g., "unnamed-connection-default" or your renamed tab)'),
  // Parameters for goto action
  url: z.string().optional().describe('URL to navigate to (required for goto action)'),
  waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle0', 'networkidle2']).optional().describe('When to consider navigation complete (for goto and reload actions, default: load)'),
  // Parameters for reload action
  ignoreCache: z.boolean().optional().describe('Clear browser cache before reloading (for reload action, default: false)'),
  timeout: z.number().optional().describe('Maximum time to wait for reload in ms (for reload action, default: 30000ms)'),
}).strict();

export function createPageTools(
  puppeteerManager: PuppeteerManager,
  cdpManager: CDPManager,
  consoleMonitor: ConsoleMonitor,
  networkMonitor: NetworkMonitor,
  connectionManager: ConnectionManager,
  resolveConnectionFromReason: (connectionReason: string) => Promise<any>,
  clickableCache: ClickableCache,
  executeToolCall?: (toolName: string, params: Record<string, any>) => Promise<any>
) {
  /**
   * Auto-restart console and network monitoring after navigation
   */
  const restartMonitoring = (page: any, monitor: ConsoleMonitor, netMonitor: NetworkMonitor) => {
    if (monitor.isActive()) {
      monitor.startMonitoring(page);
    }
    if (netMonitor.isActive()) {
      netMonitor.startMonitoring(page);
    }
  };


  return {
    navigate: createTool(
      'Navigate and control browser pages. Actions: goto (navigate to URL), reload (reload page), back (navigate back), forward (navigate forward), info (get page information)',
      navigateSchema,
      async (args) => {
        const { action, connectionReason } = args;

        // Validate required parameters for each action
        if (action === 'goto' && !args.url) {
          return createErrorResponse('MISSING_PARAMETER', {
            action: 'goto',
            missing: 'url',
            message: 'The "goto" action requires a "url" parameter'
          });
        }

        // Resolve connection from reason
        let resolved = await resolveConnectionFromReason(connectionReason);

        // Auto-launch Chrome for 'goto' action if no connection found
        if (!resolved && action === 'goto' && executeToolCall) {
          const launchResult = await autoLaunchChrome(executeToolCall, connectionReason, 'navigate.goto');
          if (!launchResult.success) {
            return createErrorResponse(launchResult.errorType, {
              reference: connectionReason,
              error: launchResult.error
            });
          }
          // Try resolving again after launch
          resolved = await resolveConnectionFromReason(connectionReason);
        }

        if (!resolved) {
          return createErrorResponse('CONNECTION_NOT_FOUND', {
            message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
          });
        }

        const targetPuppeteerManager = resolved.puppeteerManager || puppeteerManager;
        const targetCdpManager = resolved.cdpManager;
        const targetConsoleMonitor = resolved.consoleMonitor || consoleMonitor;
        const targetNetworkMonitor = resolved.networkMonitor || networkMonitor;

        const error = checkBrowserAutomation(targetCdpManager, targetPuppeteerManager, `navigate.${action}`, resolved.connection.port);
        if (error) {
          return error;
        }

        const page = targetPuppeteerManager.getPage();

        // Handle each action
        switch (action) {
          case 'goto': {
            const result = await executeWithPauseDetection(
              targetCdpManager,
              async () => {
                await page.goto(args.url!, { waitUntil: args.waitUntil ?? 'load' });

                // Auto-restart monitoring after navigation
                restartMonitoring(page, targetConsoleMonitor, targetNetworkMonitor);

                // Gather full page context
                return gatherPageContext(page, targetConsoleMonitor, targetNetworkMonitor, clickableCache);
              },
              'navigateTo'
            );

            if (!result.result) {
              return createSuccessResponse('PAGE_NAVIGATE_SUCCESS', { url: args.url });
            }

            return createSuccessResponse('PAGE_NAVIGATE_SUCCESS', formatPageContextForResponse(result.result));
          }

          case 'reload': {
            const result = await executeWithPauseDetection(
              targetCdpManager,
              async () => {
                // Clear cache before reload if requested
                if (args.ignoreCache) {
                  const client = await page.createCDPSession();
                  await client.send('Network.clearBrowserCache');
                }

                // Reload with specified waitUntil condition and timeout
                await page.reload({
                  waitUntil: args.waitUntil ?? 'load',
                  timeout: args.timeout ?? 30000
                });

                // Auto-restart monitoring after reload
                restartMonitoring(page, targetConsoleMonitor, targetNetworkMonitor);

                // Gather full page context
                return gatherPageContext(page, targetConsoleMonitor, targetNetworkMonitor, clickableCache);
              },
              'reloadPage'
            );

            if (!result.result) {
              return createSuccessResponse('PAGE_RELOAD_SUCCESS');
            }

            return createSuccessResponse('PAGE_RELOAD_SUCCESS', formatPageContextForResponse(result.result));
          }

          case 'back': {
            const result = await executeWithPauseDetection(
              targetCdpManager,
              async () => {
                await page.goBack({ waitUntil: 'load' });

                // Auto-restart monitoring after navigation
                restartMonitoring(page, targetConsoleMonitor, targetNetworkMonitor);

                // Gather full page context
                return gatherPageContext(page, targetConsoleMonitor, targetNetworkMonitor, clickableCache);
              },
              'goBack'
            );

            if (!result.result) {
              return createSuccessResponse('PAGE_GO_BACK_SUCCESS');
            }

            return createSuccessResponse('PAGE_GO_BACK_SUCCESS', formatPageContextForResponse(result.result));
          }

          case 'forward': {
            const result = await executeWithPauseDetection(
              targetCdpManager,
              async () => {
                await page.goForward({ waitUntil: 'load' });

                // Auto-restart monitoring after navigation
                restartMonitoring(page, targetConsoleMonitor, targetNetworkMonitor);

                // Gather full page context
                return gatherPageContext(page, targetConsoleMonitor, targetNetworkMonitor, clickableCache);
              },
              'goForward'
            );

            if (!result.result) {
              return createSuccessResponse('PAGE_GO_FORWARD_SUCCESS');
            }

            return createSuccessResponse('PAGE_GO_FORWARD_SUCCESS', formatPageContextForResponse(result.result));
          }

          case 'info': {
            const result = await executeWithPauseDetection(
              targetCdpManager,
              async () => {
                const url = page.url();
                const title = await page.title();
                const viewport = page.viewport();
                return { url, title, viewport };
              },
              'getPageInfo'
            );

            if (!result.result) {
              return createErrorResponse('PAGE_NOT_LOADED', { toolName: 'navigate.info' });
            }

            const pageInfo = result.result;
            const response = createSuccessResponse('PAGE_INFO_SUCCESS', {
              url: pageInfo.url,
              title: pageInfo.title
            });

            // Add structured metadata for programmatic use
            response._meta = {
              tool: 'navigate',
              action: 'info',
              timestamp: Date.now(),
              navigate: {
                url: pageInfo.url,
                title: pageInfo.title,
                action: 'info',
              },
            };

            return response;
          }

          default:
            return createErrorResponse('INVALID_ACTION', { action });
        }
      }
    ),
  };
}
