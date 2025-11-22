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
import { getConfiguredDebugPort } from '../port-config.js';
import { createSuccessResponse, createErrorResponse, formatCodeBlock } from '../messages.js';
import type { ClickableCache, ClickableElement } from '../clickable-cache.js';

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
  clickableCache: ClickableCache
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

  /**
   * Collect clickable elements from the current page and cache them
   */
  const collectAndCacheClickableElements = async (page: any): Promise<{ total: number; inViewport: number }> => {
    const elements = await page.evaluate(() => {
      // @ts-ignore - This code runs in browser context
      const results: any[] = [];
      // @ts-ignore - window is available in browser context
      const viewportHeight = window.innerHeight;
      // @ts-ignore - window is available in browser context
      const viewportWidth = window.innerWidth;

      // Find all links
      // @ts-ignore
      document.querySelectorAll('a[href]').forEach((el: any) => {
        // @ts-ignore
        const style = window.getComputedStyle(el);
        if (style.display !== 'none' && style.visibility !== 'hidden') {
          const rect = el.getBoundingClientRect();
          const inViewport = rect.top >= 0 && rect.left >= 0 &&
                           rect.bottom <= viewportHeight && rect.right <= viewportWidth;
          results.push({
            type: 'link',
            text: el.textContent?.trim() || '',
            href: el.href,
            selector: el.id ? `#${el.id}` : el.className ? `.${el.className.split(' ')[0]}` : 'a',
            inViewport,
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          });
        }
      });

      // Find all buttons
      // @ts-ignore
      document.querySelectorAll('button, input[type="button"], input[type="submit"]').forEach((el: any) => {
        // @ts-ignore
        const style = window.getComputedStyle(el);
        if (style.display !== 'none' && style.visibility !== 'hidden') {
          const rect = el.getBoundingClientRect();
          const inViewport = rect.top >= 0 && rect.left >= 0 &&
                           rect.bottom <= viewportHeight && rect.right <= viewportWidth;
          results.push({
            type: 'button',
            text: el.textContent?.trim() || el.value || '',
            href: '',
            selector: el.id ? `#${el.id}` : el.className ? `.${el.className.split(' ')[0]}` : 'button',
            inViewport,
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          });
        }
      });

      // Find all inputs
      // @ts-ignore
      document.querySelectorAll('input:not([type="button"]):not([type="submit"]), textarea, select').forEach((el: any) => {
        // @ts-ignore
        const style = window.getComputedStyle(el);
        if (style.display !== 'none' && style.visibility !== 'hidden') {
          const rect = el.getBoundingClientRect();
          const inViewport = rect.top >= 0 && rect.left >= 0 &&
                           rect.bottom <= viewportHeight && rect.right <= viewportWidth;
          results.push({
            type: 'input',
            text: el.placeholder || el.name || el.id || '',
            href: '',
            selector: el.id ? `#${el.id}` : el.name ? `[name="${el.name}"]` : 'input',
            inViewport,
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          });
        }
      });

      return { results, viewportHeight, viewportWidth };
    });

    const viewport = page.viewport();
    const url = page.url();

    // Cache the elements
    clickableCache.set(url, elements.results as ClickableElement[], elements.viewportHeight, elements.viewportWidth);

    // Count in-viewport elements
    const inViewportCount = elements.results.filter((el: any) => el.inViewport).length;

    return {
      total: elements.results.length,
      inViewport: inViewportCount,
    };
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
        const resolved = await resolveConnectionFromReason(connectionReason);
        if (!resolved) {
          return createErrorResponse('CONNECTION_NOT_FOUND', {
            message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
          });
        }

        const targetPuppeteerManager = resolved.puppeteerManager || puppeteerManager;
        const targetCdpManager = resolved.cdpManager;
        const targetConsoleMonitor = resolved.consoleMonitor || consoleMonitor;
        const targetNetworkMonitor = resolved.networkMonitor || networkMonitor;

        const error = checkBrowserAutomation(targetCdpManager, targetPuppeteerManager, `navigate.${action}`, getConfiguredDebugPort());
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

                // Collect and cache clickable elements
                const clickableStats = await collectAndCacheClickableElements(page);

                return {
                  url: page.url(),
                  title: await page.title(),
                  clickableStats,
                };
              },
              'navigateTo'
            );

            if (!result.result) {
              return createSuccessResponse('PAGE_NAVIGATE_SUCCESS', { url: args.url });
            }

            return createSuccessResponse('PAGE_NAVIGATE_SUCCESS', {
              url: result.result.url,
              title: result.result.title,
              clickableElements: {
                total: result.result.clickableStats.total,
                inViewport: result.result.clickableStats.inViewport,
                hint: 'Use content({ action: "findClickable" }) to explore clickable elements with search/filter options'
              }
            });
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

                // Collect and cache clickable elements
                const clickableStats = await collectAndCacheClickableElements(page);

                return { url: page.url(), waitUntil: args.waitUntil, clickableStats };
              },
              'reloadPage'
            );

            if (!result.result) {
              return createSuccessResponse('PAGE_RELOAD_SUCCESS');
            }

            return createSuccessResponse('PAGE_RELOAD_SUCCESS', {
              clickableElements: {
                total: result.result.clickableStats.total,
                inViewport: result.result.clickableStats.inViewport,
              }
            });
          }

          case 'back': {
            const result = await executeWithPauseDetection(
              targetCdpManager,
              async () => {
                await page.goBack({ waitUntil: 'load' });

                // Auto-restart monitoring after navigation
                restartMonitoring(page, targetConsoleMonitor, targetNetworkMonitor);

                // Collect and cache clickable elements
                const clickableStats = await collectAndCacheClickableElements(page);

                return { url: page.url(), clickableStats };
              },
              'goBack'
            );

            if (!result.result) {
              return createSuccessResponse('PAGE_GO_BACK_SUCCESS');
            }

            return createSuccessResponse('PAGE_GO_BACK_SUCCESS', {
              url: result.result.url,
              clickableElements: {
                total: result.result.clickableStats.total,
                inViewport: result.result.clickableStats.inViewport,
              }
            });
          }

          case 'forward': {
            const result = await executeWithPauseDetection(
              targetCdpManager,
              async () => {
                await page.goForward({ waitUntil: 'load' });

                // Auto-restart monitoring after navigation
                restartMonitoring(page, targetConsoleMonitor, targetNetworkMonitor);

                // Collect and cache clickable elements
                const clickableStats = await collectAndCacheClickableElements(page);

                return { url: page.url(), clickableStats };
              },
              'goForward'
            );

            if (!result.result) {
              return createSuccessResponse('PAGE_GO_FORWARD_SUCCESS');
            }

            return createSuccessResponse('PAGE_GO_FORWARD_SUCCESS', {
              url: result.result.url,
              clickableElements: {
                total: result.result.clickableStats.total,
                inViewport: result.result.clickableStats.inViewport,
              }
            });
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

          default:
            return createErrorResponse('INVALID_ACTION', { action });
        }
      }
    ),
  };
}
