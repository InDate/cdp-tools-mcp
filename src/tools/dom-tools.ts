/**
 * DOM Inspection Tools
 */

import { PuppeteerManager } from '../puppeteer-manager.js';

export function createDOMTools(puppeteerManager: PuppeteerManager) {
  return {
    querySelector: {
      description: 'Find an element by CSS selector',
      inputSchema: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS selector to query',
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
                  found: false,
                  selector: args.selector,
                }, null, 2),
              },
            ],
          };
        }

        // Get element properties
        const properties = await element.evaluate((el) => ({
          tagName: el.tagName.toLowerCase(),
          id: el.id,
          className: el.className,
          textContent: el.textContent?.substring(0, 200), // Limit text content
          visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
        }));

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                found: true,
                selector: args.selector,
                properties,
              }, null, 2),
            },
          ],
        };
      },
    },

    getElementProperties: {
      description: 'Get detailed properties of an element',
      inputSchema: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS selector to query',
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

        // Get detailed element properties
        const details = await element.evaluate((el: any) => {
          const rect = el.getBoundingClientRect();
          const win: any = (typeof (globalThis as any).window !== 'undefined') ? (globalThis as any).window : undefined;
          const styles = win?.getComputedStyle(el);

          // Get all attributes
          const attributes: Record<string, string> = {};
          for (const attr of el.attributes) {
            attributes[attr.name] = attr.value;
          }

          return {
            tagName: el.tagName.toLowerCase(),
            attributes,
            textContent: el.textContent,
            innerHTML: el.innerHTML.substring(0, 500), // Limit HTML
            boundingBox: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            },
            computedStyles: {
              display: styles.display,
              visibility: styles.visibility,
              position: styles.position,
              color: styles.color,
              backgroundColor: styles.backgroundColor,
              fontSize: styles.fontSize,
            },
            visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
          };
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                selector: args.selector,
                element: details,
              }, null, 2),
            },
          ],
        };
      },
    },

    getDOMSnapshot: {
      description: 'Get a text-based snapshot of the DOM structure',
      inputSchema: {
        type: 'object',
        properties: {
          maxDepth: {
            type: 'number',
            description: 'Maximum depth to traverse (default: 5)',
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
        const maxDepth = args.maxDepth || 5;

        // Get DOM snapshot using accessibility tree (more concise than full DOM)
        const snapshot = await page.accessibility.snapshot();

        // Also get basic DOM structure
        const domStructure = await page.evaluate((depth: number) => {
          function getNodeInfo(node: any, currentDepth: number): any {
            if (currentDepth > depth) return null;

            const children: any[] = [];
            for (const child of node.children) {
              const childInfo = getNodeInfo(child, currentDepth + 1);
              if (childInfo) children.push(childInfo);
            }

            return {
              tag: node.tagName.toLowerCase(),
              id: node.id || undefined,
              class: node.className || undefined,
              children: children.length > 0 ? children : undefined,
            };
          }

          const doc: any = (typeof (globalThis as any).document !== 'undefined') ? (globalThis as any).document : undefined;
          return getNodeInfo(doc?.body, 0);
        }, maxDepth);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                accessibilityTree: snapshot,
                domStructure,
              }, null, 2),
            },
          ],
        };
      },
    },
  };
}
