/**
 * Page Navigation Tools
 */

import { PuppeteerManager } from '../puppeteer-manager.js';

export function createPageTools(puppeteerManager: PuppeteerManager) {
  return {
    navigateTo: {
      description: 'Navigate to a URL',
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

        await page.goto(args.url, { waitUntil });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: `Navigated to ${args.url}`,
                url: page.url(),
                title: await page.title(),
              }, null, 2),
            },
          ],
        };
      },
    },

    reloadPage: {
      description: 'Reload the current page',
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

        await page.reload({ waitUntil: 'load' });
        if (ignoreCache) {
          // Force cache clear by reloading with CDP
          const client = await page.createCDPSession();
          await client.send('Network.clearBrowserCache');
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'Page reloaded',
                url: page.url(),
              }, null, 2),
            },
          ],
        };
      },
    },

    goBack: {
      description: 'Navigate backward in browser history',
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
        await page.goBack({ waitUntil: 'load' });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'Navigated back',
                url: page.url(),
              }, null, 2),
            },
          ],
        };
      },
    },

    goForward: {
      description: 'Navigate forward in browser history',
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
        await page.goForward({ waitUntil: 'load' });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'Navigated forward',
                url: page.url(),
              }, null, 2),
            },
          ],
        };
      },
    },

    getPageInfo: {
      description: 'Get information about the current page',
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
        const url = page.url();
        const title = await page.title();
        const viewport = page.viewport();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                url,
                title,
                viewport,
              }, null, 2),
            },
          ],
        };
      },
    },
  };
}
