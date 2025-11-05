/**
 * Page Navigation Tools
 */

import type { CDPManager } from '../cdp-manager.js';
import { PuppeteerManager } from '../puppeteer-manager.js';
import { executeWithPauseDetection, formatActionResult } from '../debugger-aware-wrapper.js';

export function createPageTools(puppeteerManager: PuppeteerManager, cdpManager: CDPManager) {
  return {
    navigateTo: {
      description: 'Navigate to a URL. Automatically handles breakpoints.',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to navigate to',
          },
          waitUntil: {
            type: 'string',
            description: 'When to consider navigation complete: load, domcontentloaded, networkidle0, networkidle2 (default: load)',
            enum: ['load', 'domcontentloaded', 'networkidle0', 'networkidle2'],
          },
        },
        required: ['url'],
      },
      handler: async (args: any) => {
        if (!puppeteerManager.isConnected()) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'Not connected to browser',
                }, null, 2),
              },
            ],
          };
        }

        const page = puppeteerManager.getPage();
        const waitUntil = args.waitUntil || 'load';

        const result = await executeWithPauseDetection(
          cdpManager,
          async () => {
            await page.goto(args.url, { waitUntil });
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
      },
    },

    reloadPage: {
      description: 'Reload the current page. Automatically handles breakpoints.',
      inputSchema: {
        type: 'object',
        properties: {
          ignoreCache: {
            type: 'boolean',
            description: 'Bypass cache when reloading (default: false)',
          },
        },
      },
      handler: async (args: any) => {
        if (!puppeteerManager.isConnected()) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'Not connected to browser',
                }, null, 2),
              },
            ],
          };
        }

        const page = puppeteerManager.getPage();
        const ignoreCache = args.ignoreCache || false;

        const result = await executeWithPauseDetection(
          cdpManager,
          async () => {
            await page.reload({ waitUntil: 'load' });
            if (ignoreCache) {
              const client = await page.createCDPSession();
              await client.send('Network.clearBrowserCache');
            }
            return { url: page.url() };
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
      },
    },

    goBack: {
      description: 'Navigate backward in browser history. Automatically handles breakpoints.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async () => {
        if (!puppeteerManager.isConnected()) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'Not connected to browser',
                }, null, 2),
              },
            ],
          };
        }

        const page = puppeteerManager.getPage();

        const result = await executeWithPauseDetection(
          cdpManager,
          async () => {
            await page.goBack({ waitUntil: 'load' });
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
      },
    },

    goForward: {
      description: 'Navigate forward in browser history. Automatically handles breakpoints.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async () => {
        if (!puppeteerManager.isConnected()) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'Not connected to browser',
                }, null, 2),
              },
            ],
          };
        }

        const page = puppeteerManager.getPage();

        const result = await executeWithPauseDetection(
          cdpManager,
          async () => {
            await page.goForward({ waitUntil: 'load' });
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
      },
    },

    getPageInfo: {
      description: 'Get information about the current page. Automatically handles breakpoints.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async () => {
        if (!puppeteerManager.isConnected()) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'Not connected to browser',
                }, null, 2),
              },
            ],
          };
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
      },
    },
  };
}
