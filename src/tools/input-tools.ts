/**
 * Input Automation Tools
 */

import { z } from 'zod';
import type { CDPManager } from '../cdp-manager.js';
import { PuppeteerManager } from '../puppeteer-manager.js';
import type { ConnectionManager } from '../connection-manager.js';
import { executeWithPauseDetection, formatActionResult } from '../debugger-aware-wrapper.js';
import { checkBrowserAutomation } from '../error-helpers.js';
import { createTool } from '../validation-helpers.js';
import { getConfiguredDebugPort } from '../index.js';
import { createSuccessResponse, createErrorResponse } from '../messages.js';

// Zod schemas for input validation
const clickElementSchema = z.object({
  selector: z.string(),
  clickCount: z.number().default(1),
  connectionId: z.string().describe('The connection ID of the tab to click in'),
}).strict();

const typeTextSchema = z.object({
  selector: z.string(),
  text: z.string(),
  delay: z.number().default(0),
  connectionId: z.string().describe('The connection ID of the tab to type in'),
}).strict();

const pressKeySchema = z.object({
  key: z.string(),
  connectionId: z.string().describe('The connection ID of the tab to press keys in'),
}).strict();

const hoverElementSchema = z.object({
  selector: z.string(),
  connectionId: z.string().describe('The connection ID of the tab to hover in'),
}).strict();

export function createInputTools(puppeteerManager: PuppeteerManager, cdpManager: CDPManager, connectionManager: ConnectionManager) {
  return {
    clickElement: createTool(
      'Click an element by CSS selector. Automatically handles breakpoints.',
      clickElementSchema,
      async (args) => {
        // Get connection-specific managers
        const connection = connectionManager.getConnection(args.connectionId);
        if (!connection) {
          return createErrorResponse('CONNECTION_NOT_FOUND', { connectionId: args.connectionId });
        }
        const targetPuppeteerManager = connection.puppeteerManager || puppeteerManager;
        const targetCdpManager = connection.cdpManager;

        const error = checkBrowserAutomation(targetCdpManager, targetPuppeteerManager, 'clickElement', getConfiguredDebugPort());
        if (error) {
          return error;
        }

        const page = targetPuppeteerManager.getPage();

        const result = await executeWithPauseDetection(
          targetCdpManager,
          async () => {
            // Check if element exists and is clickable
            const element = await page.$(args.selector);
            if (!element) {
              return {
                error: `Element not found: ${args.selector}`,
              };
            }

            // Check if element has click handlers
            const hasClickHandler = await page.evaluate((sel: string) => {
              const el = (globalThis as any).document.querySelector(sel);
              if (!el) return false;

              // Check for onclick attribute
              if (el.onclick) return true;

              // Check for addEventListener listeners (limited - can't detect all)
              // Check if element or ancestors have event listeners by testing common patterns
              let current = el;
              while (current) {
                // Check for common click-related attributes
                if (current.hasAttribute('onclick')) return true;
                if (current.hasAttribute('data-action')) return true;

                // Check for interactive elements that typically have handlers
                const tag = current.tagName.toLowerCase();
                if (tag === 'button' || tag === 'a' || tag === 'input') return true;

                // Check for cursor pointer (often indicates clickable)
                const style = (globalThis as any).window.getComputedStyle(current);
                if (style.cursor === 'pointer') return true;

                current = current.parentElement;
              }

              return false;
            }, args.selector);

            // Perform the click
            await page.click(args.selector, { clickCount: args.clickCount });

            return {
              selector: args.selector,
              clickCount: args.clickCount,
              hasClickHandler,
              warning: !hasClickHandler ? 'Element may not have a click handler attached. Click was performed but may not trigger any action.' : undefined,
            };
          },
          'click'
        );

        // Check if element was not found
        if (!result.result || result.result.error) {
          return createErrorResponse('ELEMENT_NOT_FOUND', { selector: args.selector });
        }

        // Return success with warning if no click handler detected
        if (result.result.warning) {
          return createSuccessResponse('ELEMENT_CLICK_WARNING', { selector: args.selector });
        }

        return createSuccessResponse('ELEMENT_CLICK_SUCCESS', { selector: args.selector });
      }
    ),

    typeText: createTool(
      'Type text into an element. Automatically handles breakpoints.',
      typeTextSchema,
      async (args) => {
        // Get connection-specific managers
        const connection = connectionManager.getConnection(args.connectionId);
        if (!connection) {
          return createErrorResponse('CONNECTION_NOT_FOUND', { connectionId: args.connectionId });
        }
        const targetPuppeteerManager = connection.puppeteerManager || puppeteerManager;
        const targetCdpManager = connection.cdpManager;

        const error = checkBrowserAutomation(targetCdpManager, targetPuppeteerManager, 'typeText', getConfiguredDebugPort());
        if (error) {
          return error;
        }

        const page = targetPuppeteerManager.getPage();

        const result = await executeWithPauseDetection(
          targetCdpManager,
          async () => {
            // Check if element exists first
            const element = await page.$(args.selector);
            if (!element) {
              return { error: `Element not found: ${args.selector}` };
            }

            // Clear existing text first
            await page.click(args.selector, { clickCount: 3 });
            await page.keyboard.press('Backspace');
            // Type new text
            await page.type(args.selector, args.text, { delay: args.delay });

            return { selector: args.selector, text: args.text };
          },
          'typeText'
        );

        // Check if element was not found
        if (result.result?.error) {
          return createErrorResponse('ELEMENT_NOT_FOUND', { selector: args.selector });
        }

        return createSuccessResponse('TEXT_TYPE_SUCCESS', {
          selector: args.selector,
          text: args.text
        });
      }
    ),

    pressKey: createTool(
      'Press a keyboard key or key combination. Automatically handles breakpoints.',
      pressKeySchema,
      async (args) => {
        // Get connection-specific managers
        const connection = connectionManager.getConnection(args.connectionId);
        if (!connection) {
          return createErrorResponse('CONNECTION_NOT_FOUND', { connectionId: args.connectionId });
        }
        const targetPuppeteerManager = connection.puppeteerManager || puppeteerManager;
        const targetCdpManager = connection.cdpManager;

        const error = checkBrowserAutomation(targetCdpManager, targetPuppeteerManager, 'pressKey', getConfiguredDebugPort());
        if (error) {
          return error;
        }

        const page = targetPuppeteerManager.getPage();

        await executeWithPauseDetection(
          targetCdpManager,
          () => page.keyboard.press(args.key as any),
          'pressKey'
        );

        return createSuccessResponse('KEY_PRESS_SUCCESS', {
          key: args.key
        });
      }
    ),

    hoverElement: createTool(
      'Hover over an element. Automatically handles breakpoints.',
      hoverElementSchema,
      async (args) => {
        // Get connection-specific managers
        const connection = connectionManager.getConnection(args.connectionId);
        if (!connection) {
          return createErrorResponse('CONNECTION_NOT_FOUND', { connectionId: args.connectionId });
        }
        const targetPuppeteerManager = connection.puppeteerManager || puppeteerManager;
        const targetCdpManager = connection.cdpManager;

        const error = checkBrowserAutomation(targetCdpManager, targetPuppeteerManager, 'hoverElement', getConfiguredDebugPort());
        if (error) {
          return error;
        }

        const page = targetPuppeteerManager.getPage();

        const result = await executeWithPauseDetection(
          targetCdpManager,
          async () => {
            // Check if element exists first
            const element = await page.$(args.selector);
            if (!element) {
              return { error: `Element not found: ${args.selector}` };
            }

            await page.hover(args.selector);
            return { selector: args.selector };
          },
          'hoverElement'
        );

        // Check if element was not found
        if (result.result?.error) {
          return createErrorResponse('ELEMENT_NOT_FOUND', { selector: args.selector });
        }

        return createSuccessResponse('ELEMENT_HOVER_SUCCESS', {
          selector: args.selector
        });
      }
    ),
  };
}
