/**
 * Input Automation Tools
 */

import { z } from 'zod';
import type { CDPManager } from '../cdp-manager.js';
import { PuppeteerManager } from '../puppeteer-manager.js';
import { executeWithPauseDetection, formatActionResult } from '../debugger-aware-wrapper.js';
import { checkBrowserAutomation, formatErrorResponse } from '../error-helpers.js';
import { createTool } from '../validation-helpers.js';
import { getConfiguredDebugPort } from '../index.js';

// Zod schemas for input validation
const clickElementSchema = z.object({
  selector: z.string(),
  clickCount: z.number().default(1),
}).strict();

const typeTextSchema = z.object({
  selector: z.string(),
  text: z.string(),
  delay: z.number().default(0),
}).strict();

const pressKeySchema = z.object({
  key: z.string(),
}).strict();

const hoverElementSchema = z.object({
  selector: z.string(),
}).strict();

export function createInputTools(puppeteerManager: PuppeteerManager, cdpManager: CDPManager) {
  return {
    clickElement: createTool(
      'Click an element by CSS selector. Automatically handles breakpoints.',
      clickElementSchema,
      async (args) => {
        const error = checkBrowserAutomation(cdpManager, puppeteerManager, 'clickElement', getConfiguredDebugPort());
        if (error) {
          return formatErrorResponse(error);
        }

        const page = puppeteerManager.getPage();

        const result = await executeWithPauseDetection(
          cdpManager,
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

        const response = formatActionResult(result, 'clickElement', result.result);

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

    typeText: createTool(
      'Type text into an element. Automatically handles breakpoints.',
      typeTextSchema,
      async (args) => {
        const error = checkBrowserAutomation(cdpManager, puppeteerManager, 'typeText', getConfiguredDebugPort());
        if (error) {
          return formatErrorResponse(error);
        }

        const page = puppeteerManager.getPage();

        const result = await executeWithPauseDetection(
          cdpManager,
          async () => {
            // Clear existing text first
            await page.click(args.selector, { clickCount: 3 });
            await page.keyboard.press('Backspace');
            // Type new text
            await page.type(args.selector, args.text, { delay: args.delay });
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
      }
    ),

    pressKey: createTool(
      'Press a keyboard key or key combination. Automatically handles breakpoints.',
      pressKeySchema,
      async (args) => {
        const error = checkBrowserAutomation(cdpManager, puppeteerManager, 'pressKey', getConfiguredDebugPort());
        if (error) {
          return formatErrorResponse(error);
        }

        const page = puppeteerManager.getPage();

        const result = await executeWithPauseDetection(
          cdpManager,
          () => page.keyboard.press(args.key as any),
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
      }
    ),

    hoverElement: createTool(
      'Hover over an element. Automatically handles breakpoints.',
      hoverElementSchema,
      async (args) => {
        const error = checkBrowserAutomation(cdpManager, puppeteerManager, 'hoverElement', getConfiguredDebugPort());
        if (error) {
          return formatErrorResponse(error);
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
      }
    ),
  };
}
