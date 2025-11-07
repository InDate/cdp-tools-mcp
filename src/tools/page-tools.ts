/**
 * Page Navigation Tools
 */

import { z } from 'zod';
import type { CDPManager } from '../cdp-manager.js';
import { PuppeteerManager } from '../puppeteer-manager.js';
import { ConsoleMonitor } from '../console-monitor.js';
import { NetworkMonitor } from '../network-monitor.js';
import { executeWithPauseDetection, formatActionResult } from '../debugger-aware-wrapper.js';
import { checkBrowserAutomation, formatErrorResponse } from '../error-helpers.js';
import { createTool } from '../validation-helpers.js';
import { getConfiguredDebugPort } from '../index.js';

// Schemas
const navigateToSchema = z.object({
  url: z.string(),
  waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle0', 'networkidle2']).default('load'),
}).strict();

const reloadPageSchema = z.object({
  ignoreCache: z.boolean().default(false).describe('Clear browser cache before reloading (default: false)'),
  waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle0', 'networkidle2']).default('load').describe('When to consider navigation complete: load (default), domcontentloaded, networkidle0, or networkidle2'),
  timeout: z.number().default(30000).describe('Maximum time to wait for reload in milliseconds (default: 30000ms / 30s)'),
}).strict();

const emptySchema = z.object({}).strict();

export function createPageTools(
  puppeteerManager: PuppeteerManager,
  cdpManager: CDPManager,
  consoleMonitor: ConsoleMonitor,
  networkMonitor: NetworkMonitor
) {
  /**
   * Auto-restart console and network monitoring after navigation
   */
  const restartMonitoring = (page: any) => {
    if (consoleMonitor.isActive()) {
      consoleMonitor.startMonitoring(page);
    }
    if (networkMonitor.isActive()) {
      networkMonitor.startMonitoring(page);
    }
  };

  return {
    navigateTo: createTool(
      'Navigate to a URL. Automatically handles breakpoints.',
      navigateToSchema,
      async (args) => {
        const error = checkBrowserAutomation(cdpManager, puppeteerManager, 'navigateTo', getConfiguredDebugPort());
        if (error) {
          return formatErrorResponse(error);
        }

        const page = puppeteerManager.getPage();

        const result = await executeWithPauseDetection(
          cdpManager,
          async () => {
            await page.goto(args.url, { waitUntil: args.waitUntil });

            // Auto-restart monitoring after navigation
            restartMonitoring(page);

            return {
              url: page.url(),
              title: await page.title(),
            };
          },
          'navigateTo'
        );

        const response = formatActionResult(result, 'navigateTo', result.result);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      }
    ),

    reloadPage: createTool(
      'Reload the current page. Automatically handles breakpoints.',
      reloadPageSchema,
      async (args) => {
        const error = checkBrowserAutomation(cdpManager, puppeteerManager, 'reloadPage', getConfiguredDebugPort());
        if (error) {
          return formatErrorResponse(error);
        }

        const page = puppeteerManager.getPage();

        const result = await executeWithPauseDetection(
          cdpManager,
          async () => {
            // Clear cache before reload if requested
            if (args.ignoreCache) {
              const client = await page.createCDPSession();
              await client.send('Network.clearBrowserCache');
            }

            // Reload with specified waitUntil condition and timeout
            await page.reload({ waitUntil: args.waitUntil, timeout: args.timeout });

            // Auto-restart monitoring after reload
            restartMonitoring(page);

            return { url: page.url(), waitUntil: args.waitUntil };
          },
          'reloadPage'
        );

        const response = formatActionResult(result, 'reloadPage', result.result);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      }
    ),

    goBack: createTool(
      'Navigate backward in browser history. Automatically handles breakpoints.',
      emptySchema,
      async () => {
        const error = checkBrowserAutomation(cdpManager, puppeteerManager, 'goBack', getConfiguredDebugPort());
        if (error) {
          return formatErrorResponse(error);
        }

        const page = puppeteerManager.getPage();

        const result = await executeWithPauseDetection(
          cdpManager,
          async () => {
            await page.goBack({ waitUntil: 'load' });

            // Auto-restart monitoring after navigation
            restartMonitoring(page);

            return { url: page.url() };
          },
          'goBack'
        );

        const response = formatActionResult(result, 'goBack', result.result);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      }
    ),

    goForward: createTool(
      'Navigate forward in browser history. Automatically handles breakpoints.',
      emptySchema,
      async () => {
        const error = checkBrowserAutomation(cdpManager, puppeteerManager, 'goForward', getConfiguredDebugPort());
        if (error) {
          return formatErrorResponse(error);
        }

        const page = puppeteerManager.getPage();

        const result = await executeWithPauseDetection(
          cdpManager,
          async () => {
            await page.goForward({ waitUntil: 'load' });

            // Auto-restart monitoring after navigation
            restartMonitoring(page);

            return { url: page.url() };
          },
          'goForward'
        );

        const response = formatActionResult(result, 'goForward', result.result);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      }
    ),

    getPageInfo: createTool(
      'Get information about the current page. Automatically handles breakpoints.',
      emptySchema,
      async () => {
        const error = checkBrowserAutomation(cdpManager, puppeteerManager, 'getPageInfo', getConfiguredDebugPort());
        if (error) {
          return formatErrorResponse(error);
        }

        const page = puppeteerManager.getPage();

        const result = await executeWithPauseDetection(
          cdpManager,
          async () => {
            const url = page.url();
            const title = await page.title();
            const viewport = page.viewport();
            return { url, title, viewport };
          },
          'getPageInfo'
        );

        const response = formatActionResult(result, 'getPageInfo', result.result);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      }
    ),
  };
}
