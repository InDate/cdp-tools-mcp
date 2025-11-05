/**
 * Input Automation Tools
 */

import { PuppeteerManager } from '../puppeteer-manager.js';

export function createInputTools(puppeteerManager: PuppeteerManager) {
  return {
    clickElement: {
      description: 'Click an element by CSS selector. WARNING: If breakpoints are set, use dispatchClick instead to avoid blocking.',
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
          timeout: {
            type: 'number',
            description: 'Max time to wait for click to complete in ms (default: 5000)',
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
        const timeout = args.timeout || 5000;

        try {
          // Use Promise.race to add timeout protection
          await Promise.race([
            page.click(args.selector, { clickCount }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Click timeout - execution may be paused at breakpoint')), timeout)
            )
          ]);

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
        } catch (error: any) {
          // Check if it's a timeout error (likely due to breakpoint)
          if (error.message && error.message.includes('timeout')) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: false,
                    warning: 'Click timed out - execution may be paused at a breakpoint',
                    suggestion: 'Use dispatchClick instead, or use evaluateExpression to trigger the click',
                    selector: args.selector,
                  }, null, 2),
                },
              ],
            };
          }

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

    dispatchClick: {
      description: 'Dispatch a click event immediately without waiting (use when debugging with breakpoints)',
      inputSchema: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS selector of the element to click',
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
          // Use evaluateExpression to trigger click without waiting for completion
          await page.evaluate((sel: string) => {
            const doc: any = (typeof (globalThis as any).document !== 'undefined') ? (globalThis as any).document : undefined;
            const element = doc?.querySelector(sel);
            if (element) {
              element.click();
              return true;
            }
            return false;
          }, args.selector);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  message: `Click dispatched on ${args.selector} (not waiting for completion)`,
                  note: 'Execution may now be paused at a breakpoint',
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
                  error: `Failed to dispatch click: ${error}`,
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
