/**
 * DOM Inspection Tools
 */

import { z } from 'zod';
import type { CDPManager } from '../cdp-manager.js';
import { PuppeteerManager } from '../puppeteer-manager.js';
import { executeWithPauseDetection, formatActionResult } from '../debugger-aware-wrapper.js';
import { checkBrowserAutomation, formatErrorResponse } from '../error-helpers.js';
import { createTool } from '../validation-helpers.js';

// Zod schemas for DOM tools
const querySelectorSchema = z.object({
  selector: z.string(),
}).strict();

const getElementPropertiesSchema = z.object({
  selector: z.string(),
}).strict();

const getDOMSnapshotSchema = z.object({
  maxDepth: z.number().optional().default(5),
}).strict();

export function createDOMTools(puppeteerManager: PuppeteerManager, cdpManager: CDPManager) {
  return {
    querySelector: createTool(
      'Find an element by CSS selector. Automatically handles breakpoints.',
      querySelectorSchema,
      async (args) => {
        const error = checkBrowserAutomation(cdpManager, puppeteerManager, 'querySelector');
        if (error) {
          return formatErrorResponse(error);
        }

        const page = puppeteerManager.getPage();

        const result = await executeWithPauseDetection(
          cdpManager,
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

        const response = formatActionResult(result, 'querySelector', result.result);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      }
    ),

    getElementProperties: createTool(
      'Get detailed properties of an element. Automatically handles breakpoints.',
      getElementPropertiesSchema,
      async (args) => {
        const error = checkBrowserAutomation(cdpManager, puppeteerManager, 'getElementProperties');
        if (error) {
          return formatErrorResponse(error);
        }

        const page = puppeteerManager.getPage();

        const result = await executeWithPauseDetection(
          cdpManager,
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

        const response = formatActionResult(result, 'getElementProperties', result.result);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      }
    ),

    getDOMSnapshot: createTool(
      'Get a text-based snapshot of the DOM structure. Automatically handles breakpoints.',
      getDOMSnapshotSchema,
      async (args) => {
        const error = checkBrowserAutomation(cdpManager, puppeteerManager, 'getDOMSnapshot');
        if (error) {
          return formatErrorResponse(error);
        }

        const page = puppeteerManager.getPage();

        const result = await executeWithPauseDetection(
          cdpManager,
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

        const response = formatActionResult(result, 'getDOMSnapshot', result.result);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      }
    ),
  };
}
