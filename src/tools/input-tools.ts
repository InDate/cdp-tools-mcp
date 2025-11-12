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
import { isElementBlocked, detectModals } from '../utils/modal-detector.js';
import { dismissModalByStrategy, selectDismissalStrategy } from '../utils/modal-dismissal.js';

// Zod schemas for input validation
const clickElementSchema = z.object({
  selector: z.string(),
  clickCount: z.number().default(1),
  connectionReason: z.string().describe('Brief reason for needing this browser connection (3 descriptive words recommended). Auto-creates/reuses tabs.'),
  handleModals: z.boolean().default(false).describe('Automatically detect and dismiss blocking modals before clicking. Default: false'),
  dismissStrategy: z.enum(['accept', 'reject', 'close', 'remove', 'auto']).default('auto').describe('Strategy to use when dismissing modals if handleModals is true. Default: auto'),
}).strict();

const typeTextSchema = z.object({
  selector: z.string(),
  text: z.string(),
  delay: z.number().default(0),
  connectionReason: z.string().describe('Brief reason for needing this browser connection (3 descriptive words recommended). Auto-creates/reuses tabs.'),
  handleModals: z.boolean().default(false).describe('Automatically detect and dismiss blocking modals before typing. Default: false'),
  dismissStrategy: z.enum(['accept', 'reject', 'close', 'remove', 'auto']).default('auto').describe('Strategy to use when dismissing modals if handleModals is true. Default: auto'),
}).strict();

const pressKeySchema = z.object({
  key: z.string(),
  connectionReason: z.string().describe('Brief reason for needing this browser connection (3 descriptive words recommended). Auto-creates/reuses tabs.'),
}).strict();

const hoverElementSchema = z.object({
  selector: z.string(),
  connectionReason: z.string().describe('Brief reason for needing this browser connection (3 descriptive words recommended). Auto-creates/reuses tabs.'),
  handleModals: z.boolean().default(false).describe('Automatically detect and dismiss blocking modals before hovering. Default: false'),
  dismissStrategy: z.enum(['accept', 'reject', 'close', 'remove', 'auto']).default('auto').describe('Strategy to use when dismissing modals if handleModals is true. Default: auto'),
}).strict();

export function createInputTools(
  puppeteerManager: PuppeteerManager,
  cdpManager: CDPManager,
  connectionManager: ConnectionManager,
  resolveConnectionFromReason: (connectionReason: string) => Promise<any>
) {
  return {
    clickElement: createTool(
      'Click an element by CSS selector. Automatically handles breakpoints.',
      clickElementSchema,
      async (args) => {
        // Resolve connection from reason
        const resolved = await resolveConnectionFromReason(args.connectionReason);
        if (!resolved) {
          return createErrorResponse('CONNECTION_NOT_FOUND', {
            message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
          });
        }

        const targetPuppeteerManager = resolved.puppeteerManager || puppeteerManager;
        const targetCdpManager = resolved.cdpManager;

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

            // Check if element is blocked by modal
            const blockingCheck = await isElementBlocked(page, args.selector);

            if (blockingCheck.blocked && blockingCheck.blockingModal) {
              if (args.handleModals) {
                // Auto-dismiss modal
                const dismissResult = await dismissModalHelper(
                  page,
                  blockingCheck.blockingModal.selector,
                  args.dismissStrategy
                );

                // Check if dismissal was successful
                if (!dismissResult.success) {
                  return {
                    error: `Failed to dismiss blocking modal: ${dismissResult.error || 'Unknown error'}`,
                    blockingModal: blockingCheck.blockingModal,
                  };
                }

                // Re-check if element is still blocked
                const recheckBlocking = await isElementBlocked(page, args.selector);
                if (recheckBlocking.blocked) {
                  return {
                    error: `Element still blocked after dismissing modal`,
                    blockingModal: recheckBlocking.blockingModal,
                  };
                }
              } else {
                // Return error with modal information
                return {
                  error: `Element is blocked by modal`,
                  blockingModal: blockingCheck.blockingModal,
                  suggestion: `Enable handleModals parameter or call dismissModal tool first`,
                };
              }
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
          // Check if error is due to blocking modal
          if (result.result?.blockingModal) {
            return createErrorResponse('ELEMENT_BLOCKED_BY_MODAL', {
              selector: args.selector,
              modalType: result.result.blockingModal.type,
              modalDescription: result.result.blockingModal.description,
              modalSelector: result.result.blockingModal.selector,
              suggestion: result.result.suggestion,
              availableStrategies: result.result.blockingModal.dismissStrategies,
            });
          }
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
        // Resolve connection from reason
        const resolved = await resolveConnectionFromReason(args.connectionReason);
        if (!resolved) {
          return createErrorResponse('CONNECTION_NOT_FOUND', {
            message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
          });
        }

        const targetPuppeteerManager = resolved.puppeteerManager || puppeteerManager;
        const targetCdpManager = resolved.cdpManager;

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

            // Check if element is blocked by modal
            const blockingCheck = await isElementBlocked(page, args.selector);

            if (blockingCheck.blocked && blockingCheck.blockingModal) {
              if (args.handleModals) {
                // Auto-dismiss modal
                const dismissResult = await dismissModalHelper(
                  page,
                  blockingCheck.blockingModal.selector,
                  args.dismissStrategy
                );

                // Check if dismissal was successful
                if (!dismissResult.success) {
                  return {
                    error: `Failed to dismiss blocking modal: ${dismissResult.error || 'Unknown error'}`,
                    blockingModal: blockingCheck.blockingModal,
                  };
                }

                // Re-check if element is still blocked
                const recheckBlocking = await isElementBlocked(page, args.selector);
                if (recheckBlocking.blocked) {
                  return {
                    error: `Element still blocked after dismissing modal`,
                    blockingModal: recheckBlocking.blockingModal,
                  };
                }
              } else {
                // Return error with modal information
                return {
                  error: `Element is blocked by modal`,
                  blockingModal: blockingCheck.blockingModal,
                  suggestion: `Enable handleModals parameter or call dismissModal tool first`,
                };
              }
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
          // Check if error is due to blocking modal
          if (result.result?.blockingModal) {
            return createErrorResponse('ELEMENT_BLOCKED_BY_MODAL', {
              selector: args.selector,
              modalType: result.result.blockingModal.type,
              modalDescription: result.result.blockingModal.description,
              modalSelector: result.result.blockingModal.selector,
              suggestion: result.result.suggestion,
              availableStrategies: result.result.blockingModal.dismissStrategies,
            });
          }
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
        // Resolve connection from reason
        const resolved = await resolveConnectionFromReason(args.connectionReason);
        if (!resolved) {
          return createErrorResponse('CONNECTION_NOT_FOUND', {
            message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
          });
        }

        const targetPuppeteerManager = resolved.puppeteerManager || puppeteerManager;
        const targetCdpManager = resolved.cdpManager;

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
        // Resolve connection from reason
        const resolved = await resolveConnectionFromReason(args.connectionReason);
        if (!resolved) {
          return createErrorResponse('CONNECTION_NOT_FOUND', {
            message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
          });
        }

        const targetPuppeteerManager = resolved.puppeteerManager || puppeteerManager;
        const targetCdpManager = resolved.cdpManager;

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

            // Check if element is blocked by modal
            const blockingCheck = await isElementBlocked(page, args.selector);

            if (blockingCheck.blocked && blockingCheck.blockingModal) {
              if (args.handleModals) {
                // Auto-dismiss modal
                const dismissResult = await dismissModalHelper(
                  page,
                  blockingCheck.blockingModal.selector,
                  args.dismissStrategy
                );

                // Check if dismissal was successful
                if (!dismissResult.success) {
                  return {
                    error: `Failed to dismiss blocking modal: ${dismissResult.error || 'Unknown error'}`,
                    blockingModal: blockingCheck.blockingModal,
                  };
                }

                // Re-check if element is still blocked
                const recheckBlocking = await isElementBlocked(page, args.selector);
                if (recheckBlocking.blocked) {
                  return {
                    error: `Element still blocked after dismissing modal`,
                    blockingModal: recheckBlocking.blockingModal,
                  };
                }
              } else {
                // Return error with modal information
                return {
                  error: `Element is blocked by modal`,
                  blockingModal: blockingCheck.blockingModal,
                  suggestion: `Enable handleModals parameter or call dismissModal tool first`,
                };
              }
            }

            await page.hover(args.selector);
            return { selector: args.selector };
          },
          'hoverElement'
        );

        // Check if element was not found
        if (result.result?.error) {
          // Check if error is due to blocking modal
          if (result.result?.blockingModal) {
            return createErrorResponse('ELEMENT_BLOCKED_BY_MODAL', {
              selector: args.selector,
              modalType: result.result.blockingModal.type,
              modalDescription: result.result.blockingModal.description,
              modalSelector: result.result.blockingModal.selector,
              suggestion: result.result.suggestion,
              availableStrategies: result.result.blockingModal.dismissStrategies,
            });
          }
          return createErrorResponse('ELEMENT_NOT_FOUND', { selector: args.selector });
        }

        return createSuccessResponse('ELEMENT_HOVER_SUCCESS', {
          selector: args.selector
        });
      }
    ),
  };
}

/**
 * Helper function to dismiss a modal
 *
 * This is a thin wrapper around the shared dismissal logic from modal-dismissal.ts
 */
async function dismissModalHelper(
  page: any,
  modalSelector: string,
  strategy: 'accept' | 'reject' | 'close' | 'remove' | 'auto'
): Promise<{ success: boolean; error?: string }> {
  // Get modal info to determine strategy
  const modals = await detectModals(page);
  const modal = modals.find(m => m.selector === modalSelector);

  if (!modal) {
    return { success: false, error: 'Modal not found' };
  }

  // Use shared dismissal logic
  const effectiveStrategy = selectDismissalStrategy(modal, strategy);
  const result = await dismissModalByStrategy(page, modal, effectiveStrategy, 3);

  return {
    success: result.success,
    error: result.error,
  };
}
