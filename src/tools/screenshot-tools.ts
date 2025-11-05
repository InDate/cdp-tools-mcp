/**
 * Screenshot Tools
 */

import { PuppeteerManager } from '../puppeteer-manager.js';

export function createScreenshotTools(puppeteerManager: PuppeteerManager) {
  return {
    takeScreenshot: {
      description: 'Take a screenshot of the full page',
      inputSchema: {
        type: 'object',
        properties: {
          fullPage: {
            type: 'boolean',
            description: 'Capture full page including scrollable area (default: false for viewport only)',
          },
          type: {
            type: 'string',
            description: 'Image format: png or jpeg (default: jpeg)',
            enum: ['png', 'jpeg'],
          },
          quality: {
            type: 'number',
            description: 'Image quality 0-100 (only for jpeg, default: 30 for smaller size)',
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
        const fullPage = args.fullPage === true;
        const type = args.type || 'jpeg';
        const quality = args.quality || 30;

        const screenshot = await page.screenshot({
          fullPage,
          type: type as 'png' | 'jpeg',
          ...(type === 'jpeg' && { quality }),
          encoding: 'base64',
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'Screenshot captured',
                type,
                fullPage,
                data: `data:image/${type};base64,${screenshot}`,
              }, null, 2),
            },
          ],
        };
      },
    },

    takeViewportScreenshot: {
      description: 'Take a screenshot of the current viewport only',
      inputSchema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            description: 'Image format: png or jpeg (default: jpeg)',
            enum: ['png', 'jpeg'],
          },
          quality: {
            type: 'number',
            description: 'Image quality 0-100 (only for jpeg, default: 30 for smaller size)',
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
        const type = args.type || 'jpeg';
        const quality = args.quality || 30;

        const screenshot = await page.screenshot({
          fullPage: false,
          type: type as 'png' | 'jpeg',
          ...(type === 'jpeg' && { quality }),
          encoding: 'base64',
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'Viewport screenshot captured',
                type,
                data: `data:image/${type};base64,${screenshot}`,
              }, null, 2),
            },
          ],
        };
      },
    },

    takeElementScreenshot: {
      description: 'Take a screenshot of a specific element',
      inputSchema: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS selector of the element to screenshot',
          },
          type: {
            type: 'string',
            description: 'Image format: png or jpeg (default: jpeg)',
            enum: ['png', 'jpeg'],
          },
          quality: {
            type: 'number',
            description: 'Image quality 0-100 (only for jpeg, default: 30 for smaller size)',
          },
        },
        required: ['selector'],
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
        const element = await page.$(args.selector);

        if (!element) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: `Element not found: ${args.selector}`,
                }, null, 2),
              },
            ],
          };
        }

        const type = args.type || 'jpeg';
        const quality = args.quality || 30;

        const screenshot = await element.screenshot({
          type: type as 'png' | 'jpeg',
          ...(type === 'jpeg' && { quality }),
          encoding: 'base64',
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: `Screenshot of element ${args.selector} captured`,
                type,
                selector: args.selector,
                data: `data:image/${type};base64,${screenshot}`,
              }, null, 2),
            },
          ],
        };
      },
    },
  };
}
