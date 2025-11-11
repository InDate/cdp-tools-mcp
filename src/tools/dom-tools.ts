/**
 * DOM Inspection Tools
 */

import { z } from 'zod';
import type { CDPManager } from '../cdp-manager.js';
import { PuppeteerManager } from '../puppeteer-manager.js';
import type { ConnectionManager } from '../connection-manager.js';
import { executeWithPauseDetection, formatActionResult } from '../debugger-aware-wrapper.js';
import { checkBrowserAutomation } from '../error-helpers.js';
import { createTool } from '../validation-helpers.js';
import { getConfiguredDebugPort } from '../index.js';
import { createSuccessResponse, createErrorResponse, formatCodeBlock } from '../messages.js';

// Zod schemas for DOM tools
const querySelectorSchema = z.object({
  selector: z.string(),
  connectionId: z.string().describe('Connection ID of the tab'),
}).strict();

const getElementPropertiesSchema = z.object({
  selector: z.string(),
  connectionId: z.string().describe('Connection ID of the tab'),
}).strict();

const getDOMSnapshotSchema = z.object({
  maxDepth: z.number().optional().default(5),
  connectionId: z.string().describe('Connection ID of the tab'),
}).strict();

export function createDOMTools(puppeteerManager: PuppeteerManager, cdpManager: CDPManager, connectionManager: ConnectionManager) {
  return {
    querySelector: createTool(
      'Find an element by CSS selector. Automatically handles breakpoints.',
      querySelectorSchema,
      async (args) => {
        // Get connection-specific managers
        const connection = connectionManager.getConnection(args.connectionId);
        if (!connection) {
          return createErrorResponse('CONNECTION_NOT_FOUND', { connectionId: args.connectionId });
        }
        const targetPuppeteerManager = connection.puppeteerManager || puppeteerManager;
        const targetCdpManager = connection.cdpManager;

        const error = checkBrowserAutomation(targetCdpManager, targetPuppeteerManager, 'querySelector', getConfiguredDebugPort());
        if (error) {
          return error;
        }

        const page = targetPuppeteerManager.getPage();

        const result = await executeWithPauseDetection(
          targetCdpManager,
          async () => {
            const element = await page.$(args.selector);

            if (!element) {
              return { found: false, selector: args.selector };
            }

            // Get element properties
            const properties = await element.evaluate((el) => ({
              tagName: el.tagName.toLowerCase(),
              id: el.id,
              className: el.className,
              textContent: el.textContent?.substring(0, 200),
              visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
            }));

            return { found: true, selector: args.selector, properties };
          },
          'querySelector'
        );

        // Check if element was not found
        if (!result.result || !result.result.found) {
          return createErrorResponse('ELEMENT_NOT_FOUND', { selector: args.selector });
        }

        // Return element properties as code block - querySelector returns basic properties
        const markdown = `Element found: \`${args.selector}\`\n\n${formatCodeBlock(result.result.properties)}`;
        return {
          content: [
            {
              type: 'text',
              text: markdown,
            },
          ],
        };
      }
    ),

    getElementProperties: createTool(
      'Get detailed properties of an element. Automatically handles breakpoints.',
      getElementPropertiesSchema,
      async (args) => {
        // Get connection-specific managers
        const connection = connectionManager.getConnection(args.connectionId);
        if (!connection) {
          return createErrorResponse('CONNECTION_NOT_FOUND', { connectionId: args.connectionId });
        }
        const targetPuppeteerManager = connection.puppeteerManager || puppeteerManager;
        const targetCdpManager = connection.cdpManager;

        const error = checkBrowserAutomation(targetCdpManager, targetPuppeteerManager, 'getElementProperties', getConfiguredDebugPort());
        if (error) {
          return error;
        }

        const page = targetPuppeteerManager.getPage();

        const result = await executeWithPauseDetection(
          targetCdpManager,
          async () => {
            const element = await page.$(args.selector);

            if (!element) {
              return { error: `Element not found: ${args.selector}` };
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
                innerHTML: el.innerHTML.substring(0, 500),
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

            return { selector: args.selector, element: details };
          },
          'getElementProperties'
        );

        // Check if element was not found
        if (!result.result || result.result.error) {
          return createErrorResponse('ELEMENT_NOT_FOUND', { selector: args.selector });
        }

        // Return element properties as code block
        const markdown = `Element properties for \`${args.selector}\`:\n\n${formatCodeBlock(result.result.element)}`;
        return {
          content: [
            {
              type: 'text',
              text: markdown,
            },
          ],
        };
      }
    ),

    getDOMSnapshot: createTool(
      'Get a text-based snapshot of the DOM structure. Automatically handles breakpoints.',
      getDOMSnapshotSchema,
      async (args) => {
        // Get connection-specific managers
        const connection = connectionManager.getConnection(args.connectionId);
        if (!connection) {
          return createErrorResponse('CONNECTION_NOT_FOUND', { connectionId: args.connectionId });
        }
        const targetPuppeteerManager = connection.puppeteerManager || puppeteerManager;
        const targetCdpManager = connection.cdpManager;

        const error = checkBrowserAutomation(targetCdpManager, targetPuppeteerManager, 'getDOMSnapshot', getConfiguredDebugPort());
        if (error) {
          return error;
        }

        const page = targetPuppeteerManager.getPage();

        const result = await executeWithPauseDetection(
          targetCdpManager,
          async () => {
            // Get DOM snapshot using accessibility tree
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
            }, args.maxDepth);

            return {
              accessibilityTree: snapshot,
              domStructure,
            };
          },
          'getDOMSnapshot'
        );

        // Return DOM snapshot using the message template
        return createSuccessResponse('DOM_SNAPSHOT_SUCCESS', { depth: args.maxDepth }, result.result);
      }
    ),
  };
}
