/**
 * Input Automation Tools
 */

import type { CDPManager } from '../cdp-manager.js';
import { PuppeteerManager } from '../puppeteer-manager.js';
import { executeWithPauseDetection, formatActionResult } from '../debugger-aware-wrapper.js';

export function createInputTools(puppeteerManager: PuppeteerManager, cdpManager: CDPManager) {
  return {
    clickElement: {
      description: 'Click an element by CSS selector. Automatically handles breakpoints.',
      inputSchema: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS selector of the element to click',
          },
          clickCount: {
            type: 'number',
            description: 'Number of clicks (1 for single, 2 for double, default: 1)',
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
        const clickCount = args.clickCount || 1;

        const result = await executeWithPauseDetection(
          cdpManager,
          () => page.click(args.selector, { clickCount }),
          'click'
        );

        const response = formatActionResult(result, 'clickElement', {
          selector: args.selector,
          clickCount,
        });

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

    typeText: {
      description: 'Type text into an element. Automatically handles breakpoints.',
      inputSchema: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS selector of the input element',
          },
          text: {
            type: 'string',
            description: 'Text to type',
          },
          delay: {
            type: 'number',
            description: 'Delay between keystrokes in milliseconds (default: 0)',
          },
        },
        required: ['selector', 'text'],
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
        const delay = args.delay || 0;

        const result = await executeWithPauseDetection(
          cdpManager,
          async () => {
            // Clear existing text first
            await page.click(args.selector, { clickCount: 3 });
            await page.keyboard.press('Backspace');
            // Type new text
            await page.type(args.selector, args.text, { delay });
          },
          'typeText'
        );

        const response = formatActionResult(result, 'typeText', {
          selector: args.selector,
          text: args.text,
        });

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

    pressKey: {
      description: 'Press a keyboard key or key combination. Automatically handles breakpoints.',
      inputSchema: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'Key to press (e.g., Enter, Tab, ArrowDown, or combinations like Control+C)',
          },
        },
        required: ['key'],
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

        const result = await executeWithPauseDetection(
          cdpManager,
          () => page.keyboard.press(args.key),
          'pressKey'
        );

        const response = formatActionResult(result, 'pressKey', {
          key: args.key,
        });

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

    hoverElement: {
      description: 'Hover over an element. Automatically handles breakpoints.',
      inputSchema: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS selector of the element to hover',
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

        const result = await executeWithPauseDetection(
          cdpManager,
          () => page.hover(args.selector),
          'hoverElement'
        );

        const response = formatActionResult(result, 'hoverElement', {
          selector: args.selector,
        });

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
