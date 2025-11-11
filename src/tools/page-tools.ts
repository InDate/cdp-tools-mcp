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
import { getConfiguredDebugPort } from '../index.js';
import { createSuccessResponse, createErrorResponse, formatCodeBlock } from '../messages.js';

// Schemas
const navigateToSchema = z.object({
  url: z.string(),
  waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle0', 'networkidle2']).default('load'),
  connectionReason: z.string().describe('Brief reason for needing this browser connection (3 descriptive words recommended, e.g., \'search wikipedia results\', \'test checkout flow\'). Auto-creates/reuses tabs.'),
}).strict();

const reloadPageSchema = z.object({
  ignoreCache: z.boolean().default(false).describe('Clear browser cache before reloading (default: false)'),
  waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle0', 'networkidle2']).default('load').describe('When to consider navigation complete: load (default), domcontentloaded, networkidle0, or networkidle2'),
  timeout: z.number().default(30000).describe('Maximum time to wait for reload in milliseconds (default: 30000ms / 30s)'),
  connectionReason: z.string().describe('Brief reason for needing this browser connection (3 descriptive words recommended, e.g., \'search wikipedia results\', \'test checkout flow\'). Auto-creates/reuses tabs.'),
}).strict();

const goBackSchema = z.object({
  connectionReason: z.string().describe('Brief reason for needing this browser connection (3 descriptive words recommended, e.g., \'search wikipedia results\', \'test checkout flow\'). Auto-creates/reuses tabs.'),
}).strict();

const goForwardSchema = z.object({
  connectionReason: z.string().describe('Brief reason for needing this browser connection (3 descriptive words recommended, e.g., \'search wikipedia results\', \'test checkout flow\'). Auto-creates/reuses tabs.'),
}).strict();

const getPageInfoSchema = z.object({
  connectionReason: z.string().describe('Brief reason for needing this browser connection (3 descriptive words recommended, e.g., \'search wikipedia results\', \'test checkout flow\'). Auto-creates/reuses tabs.'),
}).strict();

const emptySchema = z.object({}).strict();

export function createPageTools(
  puppeteerManager: PuppeteerManager,
  cdpManager: CDPManager,
  consoleMonitor: ConsoleMonitor,
  networkMonitor: NetworkMonitor,
  connectionManager: ConnectionManager,
  resolveConnectionFromReason: (connectionReason: string) => Promise<any>
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
    navigateTo: createTool(
      'Navigate to a URL. Automatically handles breakpoints.',
      navigateToSchema,
      async (args) => {
        // Resolve connection from reason
        const resolved = await resolveConnectionFromReason(args.connectionReason);
        if (!resolved) {
          return createErrorResponse('CONNECTION_NOT_FOUND', {
            message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
          });
        }

        const targetPuppeteerManager = resolved.puppeteerManager || puppeteerManager;
        const targetCdpManager = resolved.cdpManager;
        const targetConsoleMonitor = resolved.consoleMonitor || consoleMonitor;
        const targetNetworkMonitor = resolved.networkMonitor || networkMonitor;

        const error = checkBrowserAutomation(targetCdpManager, targetPuppeteerManager, 'navigateTo', getConfiguredDebugPort());
        if (error) {
          return error;
        }

        const page = targetPuppeteerManager.getPage();

        const result = await executeWithPauseDetection(
          targetCdpManager,
          async () => {
            await page.goto(args.url, { waitUntil: args.waitUntil });

            // Auto-restart monitoring after navigation
            restartMonitoring(page, targetConsoleMonitor, targetNetworkMonitor);

            return {
              url: page.url(),
              title: await page.title(),
            };
          },
          'navigateTo'
        );

        // Return success with page info as data
        if (!result.result) {
          return createSuccessResponse('PAGE_NAVIGATE_SUCCESS', { url: args.url });
        }

        return createSuccessResponse('PAGE_NAVIGATE_SUCCESS', {
          url: result.result.url,
          title: result.result.title
        });
      }
    ),

    reloadPage: createTool(
      'Reload the current page. Automatically handles breakpoints.',
      reloadPageSchema,
      async (args) => {
        // Resolve connection from reason
        const resolved = await resolveConnectionFromReason(args.connectionReason);
        if (!resolved) {
          return createErrorResponse('CONNECTION_NOT_FOUND', {
            message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
          });
        }

        const targetPuppeteerManager = resolved.puppeteerManager || puppeteerManager;
        const targetCdpManager = resolved.cdpManager;
        const targetConsoleMonitor = resolved.consoleMonitor || consoleMonitor;
        const targetNetworkMonitor = resolved.networkMonitor || networkMonitor;

        const error = checkBrowserAutomation(targetCdpManager, targetPuppeteerManager, 'reloadPage', getConfiguredDebugPort());
        if (error) {
          return error;
        }

        const page = targetPuppeteerManager.getPage();

        await executeWithPauseDetection(
          targetCdpManager,
          async () => {
            // Clear cache before reload if requested
            if (args.ignoreCache) {
              const client = await page.createCDPSession();
              await client.send('Network.clearBrowserCache');
            }

            // Reload with specified waitUntil condition and timeout
            await page.reload({ waitUntil: args.waitUntil, timeout: args.timeout });

            // Auto-restart monitoring after reload
            restartMonitoring(page, targetConsoleMonitor, targetNetworkMonitor);

            return { url: page.url(), waitUntil: args.waitUntil };
          },
          'reloadPage'
        );

        return createSuccessResponse('PAGE_RELOAD_SUCCESS');
      }
    ),

    goBack: createTool(
      'Navigate backward in browser history. Automatically handles breakpoints.',
      goBackSchema,
      async (args) => {
        // Resolve connection from reason
        const resolved = await resolveConnectionFromReason(args.connectionReason);
        if (!resolved) {
          return createErrorResponse('CONNECTION_NOT_FOUND', {
            message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
          });
        }

        const targetPuppeteerManager = resolved.puppeteerManager || puppeteerManager;
        const targetCdpManager = resolved.cdpManager;
        const targetConsoleMonitor = resolved.consoleMonitor || consoleMonitor;
        const targetNetworkMonitor = resolved.networkMonitor || networkMonitor;

        const error = checkBrowserAutomation(targetCdpManager, targetPuppeteerManager, 'goBack', getConfiguredDebugPort());
        if (error) {
          return error;
        }

        const page = targetPuppeteerManager.getPage();

        const result = await executeWithPauseDetection(
          targetCdpManager,
          async () => {
            await page.goBack({ waitUntil: 'load' });

            // Auto-restart monitoring after navigation
            restartMonitoring(page, targetConsoleMonitor, targetNetworkMonitor);

            return { url: page.url() };
          },
          'goBack'
        );

        if (!result.result) {
          return createSuccessResponse('PAGE_GO_BACK_SUCCESS');
        }

        return createSuccessResponse('PAGE_GO_BACK_SUCCESS', {
          url: result.result.url
        });
      }
    ),

    goForward: createTool(
      'Navigate forward in browser history. Automatically handles breakpoints.',
      goForwardSchema,
      async (args) => {
        // Resolve connection from reason
        const resolved = await resolveConnectionFromReason(args.connectionReason);
        if (!resolved) {
          return createErrorResponse('CONNECTION_NOT_FOUND', {
            message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
          });
        }

        const targetPuppeteerManager = resolved.puppeteerManager || puppeteerManager;
        const targetCdpManager = resolved.cdpManager;
        const targetConsoleMonitor = resolved.consoleMonitor || consoleMonitor;
        const targetNetworkMonitor = resolved.networkMonitor || networkMonitor;

        const error = checkBrowserAutomation(targetCdpManager, targetPuppeteerManager, 'goForward', getConfiguredDebugPort());
        if (error) {
          return error;
        }

        const page = targetPuppeteerManager.getPage();

        const result = await executeWithPauseDetection(
          targetCdpManager,
          async () => {
            await page.goForward({ waitUntil: 'load' });

            // Auto-restart monitoring after navigation
            restartMonitoring(page, targetConsoleMonitor, targetNetworkMonitor);

            return { url: page.url() };
          },
          'goForward'
        );

        if (!result.result) {
          return createSuccessResponse('PAGE_GO_FORWARD_SUCCESS');
        }

        return createSuccessResponse('PAGE_GO_FORWARD_SUCCESS', {
          url: result.result.url
        });
      }
    ),

    getPageInfo: createTool(
      'Get information about the current page. Automatically handles breakpoints.',
      getPageInfoSchema,
      async (args) => {
        // Resolve connection from reason
        const resolved = await resolveConnectionFromReason(args.connectionReason);
        if (!resolved) {
          return createErrorResponse('CONNECTION_NOT_FOUND', {
            message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
          });
        }

        const targetPuppeteerManager = resolved.puppeteerManager || puppeteerManager;
        const targetCdpManager = resolved.cdpManager;

        const error = checkBrowserAutomation(targetCdpManager, targetPuppeteerManager, 'getPageInfo', getConfiguredDebugPort());
        if (error) {
          return error;
        }

        const page = targetPuppeteerManager.getPage();

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
          return {
            content: [{ type: 'text', text: 'Unable to retrieve page information' }],
          };
        }

        const pageInfo = result.result;
        const markdown = `## Page Information\n\n**URL:** ${pageInfo.url}\n**Title:** ${pageInfo.title}\n\n${formatCodeBlock(pageInfo.viewport)}`;
        return {
          content: [
            {
              type: 'text',
              text: markdown,
            },
          ],
        };
      }
    ),
  };
}
