/**
 * Screenshot Tools
 */

import type { CDPManager } from '../cdp-manager.js';
import { PuppeteerManager } from '../puppeteer-manager.js';
import { executeWithPauseDetection, formatActionResult } from '../debugger-aware-wrapper.js';

export function createScreenshotTools(puppeteerManager: PuppeteerManager, cdpManager: CDPManager) {
  return {
    takeScreenshot: {
      description: 'Take a screenshot of the full page. Low quality (10) by default to save tokens. For high-quality specific regions, use clip parameter. For screenshot analysis without token cost, use Task agent to capture and describe the screenshot.',
      inputSchema: {
        type: 'object',
        properties: {
          fullPage: {
            type: 'boolean',
            description: 'Capture full page including scrollable area (default: true)',
          },
          type: {
            type: 'string',
            description: 'Image format: png or jpeg (default: jpeg)',
            enum: ['png', 'jpeg'],
          },
          quality: {
            type: 'number',
            description: 'Image quality 0-100 (only for jpeg, default: 10 to save tokens, use 30+ with clip for quality)',
          },
          clip: {
            type: 'object',
            description: 'Capture specific region at higher quality (coordinates in pixels)',
            properties: {
              x: { type: 'number', description: 'X coordinate' },
              y: { type: 'number', description: 'Y coordinate' },
              width: { type: 'number', description: 'Width in pixels' },
              height: { type: 'number', description: 'Height in pixels' },
            },
            required: ['x', 'y', 'width', 'height'],
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
        const quality = args.quality || (args.clip ? 30 : 10);

        const screenshot = await page.screenshot({
          fullPage,
          type: type as 'png' | 'jpeg',
          ...(type === 'jpeg' && { quality }),
          ...(args.clip && { clip: args.clip }),
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
      description: 'Take a screenshot of the current viewport. Low quality (10) by default to save tokens. For high-quality specific regions, use clip parameter. For screenshot analysis without token cost, use Task agent to capture and describe the screenshot.',
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
            description: 'Image quality 0-100 (only for jpeg, default: 10 to save tokens, use 30+ with clip for quality)',
          },
          clip: {
            type: 'object',
            description: 'Capture specific region at higher quality (coordinates in pixels)',
            properties: {
              x: { type: 'number', description: 'X coordinate' },
              y: { type: 'number', description: 'Y coordinate' },
              width: { type: 'number', description: 'Width in pixels' },
              height: { type: 'number', description: 'Height in pixels' },
            },
            required: ['x', 'y', 'width', 'height'],
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
        const quality = args.quality || (args.clip ? 30 : 10);

        const screenshot = await page.screenshot({
          fullPage: false,
          type: type as 'png' | 'jpeg',
          ...(type === 'jpeg' && { quality }),
          ...(args.clip && { clip: args.clip }),
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
      description: 'Take a screenshot of a specific element. Automatically handles breakpoints.',
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
            description: 'Image quality 0-100 (only for jpeg, default: 30)',
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
        const type = args.type || 'jpeg';
        const quality = args.quality || 30;

        const result = await executeWithPauseDetection(
          cdpManager,
          async () => {
            const element = await page.$(args.selector);

            if (!element) {
              return { error: `Element not found: ${args.selector}` };
            }

            const screenshot = await element.screenshot({
              type: type as 'png' | 'jpeg',
              ...(type === 'jpeg' && { quality }),
              encoding: 'base64',
            });

            return {
              type,
              selector: args.selector,
              data: `data:image/${type};base64,${screenshot}`,
            };
          },
          'takeElementScreenshot'
        );

        const response = formatActionResult(result, 'takeElementScreenshot', result.result);

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
