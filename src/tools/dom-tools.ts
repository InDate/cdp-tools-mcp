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
import { configManager } from '../config.js';
import { createSuccessResponse, createErrorResponse, formatCodeBlock } from '../messages.js';
import { resolveSelector, isExtendedSelector, cleanupResolvedSelector } from '../utils/selector-resolver.js';

// Consolidated schema for DOM tools
const domSchema = z.object({
  action: z.enum(['querySelector', 'getProperties', 'snapshot']).describe('DOM action: querySelector (find element by selector), getProperties (get detailed element properties), snapshot (get full DOM snapshot)'),
  connectionReason: z.string().describe('Connection reference (use the reference from launchChrome output, e.g., "unnamed-connection-default" or your renamed tab)'),
  // Parameters for querySelector and getProperties actions
  selector: z.string().optional().describe('CSS selector (required for querySelector and getProperties actions). Supports extended selectors: :has-text("text") for partial match, :text("text") for exact match. Example: button:has-text("Submit")'),
  // Parameters for snapshot action
  maxDepth: z.number().optional().describe('Maximum depth for DOM snapshot (default: 5, for snapshot action)'),
}).strict();

export function createDOMTools(
  puppeteerManager: PuppeteerManager,
  cdpManager: CDPManager,
  connectionManager: ConnectionManager,
  resolveConnectionFromReason: (connectionReason: string) => Promise<any>
) {
  return {
    dom: createTool(
      'Inspect and query the DOM. Actions: querySelector (find element by CSS selector and get basic info), getProperties (get detailed properties of an element), snapshot (get full DOM structure snapshot)',
      domSchema,
      async (args) => {
        const { action, connectionReason } = args;

        // Validate required parameters for each action
        if ((action === 'querySelector' || action === 'getProperties') && !args.selector) {
          return createErrorResponse('MISSING_PARAMETER', {
            action,
            missing: 'selector',
            message: `The "${action}" action requires a "selector" parameter`
          });
        }

        // Resolve connection from reason
        const resolved = await resolveConnectionFromReason(connectionReason);
        if (!resolved) {
          return createErrorResponse('CONNECTION_NOT_FOUND', {
            message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
          });
        }

        const targetPuppeteerManager = resolved.puppeteerManager || puppeteerManager;
        const targetCdpManager = resolved.cdpManager;

        const error = checkBrowserAutomation(targetCdpManager, targetPuppeteerManager, `dom.${action}`, configManager.getCurrentPort());
        if (error) {
          return error;
        }

        const page = targetPuppeteerManager.getPage();

        // Handle each action
        switch (action) {
          case 'querySelector': {
            const rawSelector = args.selector!;

            // Resolve extended selectors (like :has-text())
            let selector = rawSelector;
            let selectorWarning: string | undefined;
            if (isExtendedSelector(selector)) {
              const resolved = await resolveSelector(page, selector);
              if ('error' in resolved) {
                return createErrorResponse('ELEMENT_NOT_FOUND', {
                  selector: rawSelector,
                  suggestion: resolved.suggestion,
                });
              }
              selector = resolved.selector;
              selectorWarning = resolved.warning;
            }

            const result = await executeWithPauseDetection(
              targetCdpManager,
              async () => {
                const element = await page.$(selector);

                if (!element) {
                  return { found: false, selector };
                }

                // Get element properties
                const properties = await element.evaluate((el: any) => ({
                  tagName: el.tagName.toLowerCase(),
                  id: el.id,
                  className: el.className,
                  textContent: el.textContent?.substring(0, 200),
                  visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
                }));

                return { found: true, selector, properties };
              },
              'querySelector'
            );

            // Clean up temporary selector attribute
            await cleanupResolvedSelector(page, selector);

            // Check if element was not found
            if (!result.result || !result.result.found) {
              return createErrorResponse('ELEMENT_NOT_FOUND', { selector: rawSelector });
            }

            // Return element properties as code block
            let markdown = `Element found: \`${rawSelector}\`\n\n${formatCodeBlock(result.result.properties)}`;
            if (selectorWarning) {
              markdown += `\n\n**Warning:** ${selectorWarning}`;
            }
            return {
              content: [
                {
                  type: 'text',
                  text: markdown,
                },
              ],
            };
          }

          case 'getProperties': {
            const rawSelector = args.selector!;

            // Resolve extended selectors (like :has-text())
            let selector = rawSelector;
            let selectorWarning: string | undefined;
            if (isExtendedSelector(selector)) {
              const resolved = await resolveSelector(page, selector);
              if ('error' in resolved) {
                return createErrorResponse('ELEMENT_NOT_FOUND', {
                  selector: rawSelector,
                  suggestion: resolved.suggestion,
                });
              }
              selector = resolved.selector;
              selectorWarning = resolved.warning;
            }

            const result = await executeWithPauseDetection(
              targetCdpManager,
              async () => {
                const element = await page.$(selector);

                if (!element) {
                  return { error: `Element not found: ${selector}` };
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

                return { selector: rawSelector, element: details };
              },
              'getElementProperties'
            );

            // Clean up temporary selector attribute
            await cleanupResolvedSelector(page, selector);

            // Check if element was not found
            if (!result.result || result.result.error) {
              return createErrorResponse('ELEMENT_NOT_FOUND', { selector: rawSelector });
            }

            // Return element properties as code block
            let markdown = `Element properties for \`${rawSelector}\`:\n\n${formatCodeBlock(result.result.element)}`;
            if (selectorWarning) {
              markdown += `\n\n**Warning:** ${selectorWarning}`;
            }
            return {
              content: [
                {
                  type: 'text',
                  text: markdown,
                },
              ],
            };
          }

          case 'snapshot': {
            const maxDepth = args.maxDepth ?? 5;

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
                }, maxDepth);

                return {
                  accessibilityTree: snapshot,
                  domStructure,
                };
              },
              'getDOMSnapshot'
            );

            // Return DOM snapshot using the message template
            return createSuccessResponse('DOM_SNAPSHOT_SUCCESS', { depth: maxDepth }, result.result);
          }

          default:
            return createErrorResponse('INVALID_ACTION', { action });
        }
      }
    ),
  };
}
