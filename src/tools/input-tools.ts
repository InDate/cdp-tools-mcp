/**
 * Input Automation Tools
 */

import { PuppeteerManager } from '../puppeteer-manager.js';

export function createInputTools(puppeteerManager: PuppeteerManager) {
  return {
    clickElement: {
      description: 'Click an element by CSS selector',
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

        try {
          await page.click(args.selector, { clickCount });

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  message: `Clicked element ${args.selector}`,
                  clickCount,
                }, null, 2),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: `Failed to click element: ${error}`,
                  selector: args.selector,
                }, null, 2),
              },
            ],
          };
        }
      },
    },

    typeText: {
      description: 'Type text into an element',
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

        try {
          // Clear existing text first
          await page.click(args.selector, { clickCount: 3 });
          await page.keyboard.press('Backspace');

          // Type new text
          await page.type(args.selector, args.text, { delay });

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  message: `Typed text into ${args.selector}`,
                  text: args.text,
                }, null, 2),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: `Failed to type text: ${error}`,
                  selector: args.selector,
                }, null, 2),
              },
            ],
          };
        }
      },
    },

    pressKey: {
      description: 'Press a keyboard key or key combination',
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

        try {
          await page.keyboard.press(args.key);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  message: `Pressed key: ${args.key}`,
                }, null, 2),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: `Failed to press key: ${error}`,
                  key: args.key,
                }, null, 2),
              },
            ],
          };
        }
      },
    },

    hoverElement: {
      description: 'Hover over an element',
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

        try {
          await page.hover(args.selector);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  message: `Hovered over element ${args.selector}`,
                }, null, 2),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: `Failed to hover: ${error}`,
                  selector: args.selector,
                }, null, 2),
              },
            ],
          };
        }
      },
    },
  };
}
