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
import { getConfiguredDebugPort } from '../port-config.js';
import { createSuccessResponse, createErrorResponse } from '../messages.js';
import { isElementBlocked, detectModals } from '../utils/modal-detector.js';
import { dismissModalByStrategy, selectDismissalStrategy } from '../utils/modal-dismissal.js';
import { resolveSelector, isExtendedSelector, cleanupResolvedSelector } from '../utils/selector-resolver.js';

// Consolidated input tool schema
const inputToolSchema = z.object({
  action: z.enum(['click', 'type', 'press', 'hover'])
    .describe('Input action: click (click element), type (type text into element), press (press keyboard key), hover (hover over element)'),
  connectionReason: z.string().describe('Connection reference (use the reference from launchChrome output, e.g., "unnamed-connection-default" or your renamed tab)'),

  // click, type, hover parameters
  selector: z.string().optional().describe('CSS selector (required for click, type, hover actions). Supports extended selectors: :has-text("text") for partial match, :text("text") for exact match. Example: button:has-text("Submit")'),
  handleModals: z.boolean().optional().describe('Auto-dismiss modals before action (for click, type, hover actions, default: false)'),
  dismissStrategy: z.enum(['accept', 'reject', 'close', 'remove', 'auto']).optional().describe('Strategy to use when dismissing modals if handleModals is true (for click, type, hover actions, default: auto)'),

  // click parameters
  clickCount: z.number().optional().describe('Number of clicks (for click action, default: 1)'),

  // type parameters
  text: z.string().optional().describe('Text to type (required for type action)'),
  delay: z.number().optional().describe('Delay between keystrokes in ms (for type action, default: 0)'),

  // press parameters
  key: z.string().optional().describe('Key to press (required for press action)'),
}).strict();

export function createInputTools(
  puppeteerManager: PuppeteerManager,
  cdpManager: CDPManager,
  connectionManager: ConnectionManager,
  resolveConnectionFromReason: (connectionReason: string) => Promise<any>
) {
  return {
    input: createTool(
      'Perform browser input actions. Actions: click (click element), type (type text into element), press (press keyboard key), hover (hover over element)',
      inputToolSchema,
      async (args) => {
        const { action, connectionReason } = args;

        // Resolve connection from reason
        const resolved = await resolveConnectionFromReason(connectionReason);
        if (!resolved) {
          return createErrorResponse('CONNECTION_NOT_FOUND', {
            message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
          });
        }

        const targetPuppeteerManager = resolved.puppeteerManager || puppeteerManager;
        const targetCdpManager = resolved.cdpManager;

        const error = checkBrowserAutomation(targetCdpManager, targetPuppeteerManager, action, getConfiguredDebugPort());
        if (error) {
          return error;
        }

        const page = targetPuppeteerManager.getPage();

        switch (action) {
          case 'click': {
            const { selector: rawSelector, clickCount = 1, handleModals = false, dismissStrategy = 'auto' } = args;

            if (!rawSelector) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `## Error\n\nMissing required parameter: \`selector\`\n\n**Action:** click\n\n**Suggestion:** Provide a CSS selector for the element to click.`,
                  },
                ],
                isError: true,
              };
            }

            // Resolve extended selectors (like :has-text())
            let selector = rawSelector;
            let selectorWarning: string | undefined;
            if (isExtendedSelector(rawSelector)) {
              const resolved = await resolveSelector(page, rawSelector);
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
                // Check if element exists and is clickable
                const element = await page.$(selector);
                if (!element) {
                  return {
                    error: `Element not found: ${selector}`,
                  };
                }

                // Check if element is blocked by modal
                const blockingCheck = await isElementBlocked(page, selector);

                if (blockingCheck.blocked && blockingCheck.blockingModal) {
                  if (handleModals) {
                    // Auto-dismiss modal
                    const dismissResult = await dismissModalHelper(
                      page,
                      blockingCheck.blockingModal.selector,
                      dismissStrategy
                    );

                    // Check if dismissal was successful
                    if (!dismissResult.success) {
                      return {
                        error: `Failed to dismiss blocking modal: ${dismissResult.error || 'Unknown error'}`,
                        blockingModal: blockingCheck.blockingModal,
                      };
                    }

                    // Re-check if element is still blocked
                    const recheckBlocking = await isElementBlocked(page, selector);
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
                }, selector);

                // Perform the click
                await page.click(selector, { clickCount });

                return {
                  selector,
                  clickCount,
                  hasClickHandler,
                  warning: !hasClickHandler ? 'Element may not have a click handler attached. Click was performed but may not trigger any action.' : undefined,
                };
              },
              'click'
            );

            // Clean up temporary selector attribute
            await cleanupResolvedSelector(page, selector);

            // Check if element was not found
            if (!result.result || result.result.error) {
              // Check if error is due to blocking modal
              if (result.result?.blockingModal) {
                return createErrorResponse('ELEMENT_BLOCKED_BY_MODAL', {
                  selector: rawSelector,
                  modalType: result.result.blockingModal.type,
                  modalDescription: result.result.blockingModal.description,
                  modalSelector: result.result.blockingModal.selector,
                  suggestion: result.result.suggestion,
                  availableStrategies: result.result.blockingModal.dismissStrategies,
                });
              }
              return createErrorResponse('ELEMENT_NOT_FOUND', { selector: rawSelector });
            }

            // Return success with warning if no click handler detected
            if (result.result.warning) {
              return createSuccessResponse('ELEMENT_CLICK_WARNING', { selector: rawSelector, warning: selectorWarning });
            }

            // Include warning about multiple matches if applicable
            if (selectorWarning) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Clicked element \`${rawSelector}\`\n\n**Warning:** ${selectorWarning}`,
                  },
                ],
              };
            }

            return createSuccessResponse('ELEMENT_CLICK_SUCCESS', { selector: rawSelector });
          }

          case 'type': {
            const { selector: rawSelector, text, delay = 0, handleModals = false, dismissStrategy = 'auto' } = args;

            if (!rawSelector) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `## Error\n\nMissing required parameter: \`selector\`\n\n**Action:** type\n\n**Suggestion:** Provide a CSS selector for the input element.`,
                  },
                ],
                isError: true,
              };
            }

            if (!text) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `## Error\n\nMissing required parameter: \`text\`\n\n**Action:** type\n\n**Suggestion:** Provide text to type into the element.`,
                  },
                ],
                isError: true,
              };
            }

            // Resolve extended selectors (like :has-text())
            let selector = rawSelector;
            let selectorWarning: string | undefined;
            if (isExtendedSelector(rawSelector)) {
              const resolved = await resolveSelector(page, rawSelector);
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
                // Check if element exists first
                const element = await page.$(selector);
                if (!element) {
                  return { error: `Element not found: ${selector}` };
                }

                // Check if element is blocked by modal
                const blockingCheck = await isElementBlocked(page, selector);

                if (blockingCheck.blocked && blockingCheck.blockingModal) {
                  if (handleModals) {
                    // Auto-dismiss modal
                    const dismissResult = await dismissModalHelper(
                      page,
                      blockingCheck.blockingModal.selector,
                      dismissStrategy
                    );

                    // Check if dismissal was successful
                    if (!dismissResult.success) {
                      return {
                        error: `Failed to dismiss blocking modal: ${dismissResult.error || 'Unknown error'}`,
                        blockingModal: blockingCheck.blockingModal,
                      };
                    }

                    // Re-check if element is still blocked
                    const recheckBlocking = await isElementBlocked(page, selector);
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
                await page.click(selector, { clickCount: 3 });
                await page.keyboard.press('Backspace');
                // Type new text
                await page.type(selector, text, { delay });

                return { selector, text };
              },
              'typeText'
            );

            // Clean up temporary selector attribute
            await cleanupResolvedSelector(page, selector);

            // Check if element was not found
            if (result.result?.error) {
              // Check if error is due to blocking modal
              if (result.result?.blockingModal) {
                return createErrorResponse('ELEMENT_BLOCKED_BY_MODAL', {
                  selector: rawSelector,
                  modalType: result.result.blockingModal.type,
                  modalDescription: result.result.blockingModal.description,
                  modalSelector: result.result.blockingModal.selector,
                  suggestion: result.result.suggestion,
                  availableStrategies: result.result.blockingModal.dismissStrategies,
                });
              }
              return createErrorResponse('ELEMENT_NOT_FOUND', { selector: rawSelector });
            }

            // Include warning about multiple matches if applicable
            if (selectorWarning) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Typed into element \`${rawSelector}\`\n\n**Warning:** ${selectorWarning}`,
                  },
                ],
              };
            }

            return createSuccessResponse('TEXT_TYPE_SUCCESS', {
              selector: rawSelector,
              text
            });
          }

          case 'press': {
            const { key } = args;

            if (!key) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `## Error\n\nMissing required parameter: \`key\`\n\n**Action:** press\n\n**Suggestion:** Provide a key name to press (e.g., "Enter", "Tab", "Escape").`,
                  },
                ],
                isError: true,
              };
            }

            await executeWithPauseDetection(
              targetCdpManager,
              () => page.keyboard.press(key as any),
              'pressKey'
            );

            return createSuccessResponse('KEY_PRESS_SUCCESS', {
              key
            });
          }

          case 'hover': {
            const { selector: rawSelector, handleModals = false, dismissStrategy = 'auto' } = args;

            if (!rawSelector) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `## Error\n\nMissing required parameter: \`selector\`\n\n**Action:** hover\n\n**Suggestion:** Provide a CSS selector for the element to hover over.`,
                  },
                ],
                isError: true,
              };
            }

            // Resolve extended selectors (like :has-text())
            let selector = rawSelector;
            let selectorWarning: string | undefined;
            if (isExtendedSelector(rawSelector)) {
              const resolved = await resolveSelector(page, rawSelector);
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
                // Check if element exists first
                const element = await page.$(selector);
                if (!element) {
                  return { error: `Element not found: ${selector}` };
                }

                // Check if element is blocked by modal
                const blockingCheck = await isElementBlocked(page, selector);

                if (blockingCheck.blocked && blockingCheck.blockingModal) {
                  if (handleModals) {
                    // Auto-dismiss modal
                    const dismissResult = await dismissModalHelper(
                      page,
                      blockingCheck.blockingModal.selector,
                      dismissStrategy
                    );

                    // Check if dismissal was successful
                    if (!dismissResult.success) {
                      return {
                        error: `Failed to dismiss blocking modal: ${dismissResult.error || 'Unknown error'}`,
                        blockingModal: blockingCheck.blockingModal,
                      };
                    }

                    // Re-check if element is still blocked
                    const recheckBlocking = await isElementBlocked(page, selector);
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

                await page.hover(selector);
                return { selector };
              },
              'hoverElement'
            );

            // Clean up temporary selector attribute
            await cleanupResolvedSelector(page, selector);

            // Check if element was not found
            if (result.result?.error) {
              // Check if error is due to blocking modal
              if (result.result?.blockingModal) {
                return createErrorResponse('ELEMENT_BLOCKED_BY_MODAL', {
                  selector: rawSelector,
                  modalType: result.result.blockingModal.type,
                  modalDescription: result.result.blockingModal.description,
                  modalSelector: result.result.blockingModal.selector,
                  suggestion: result.result.suggestion,
                  availableStrategies: result.result.blockingModal.dismissStrategies,
                });
              }
              return createErrorResponse('ELEMENT_NOT_FOUND', { selector: rawSelector });
            }

            // Include warning about multiple matches if applicable
            if (selectorWarning) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Hovered over element \`${rawSelector}\`\n\n**Warning:** ${selectorWarning}`,
                  },
                ],
              };
            }

            return createSuccessResponse('ELEMENT_HOVER_SUCCESS', {
              selector: rawSelector
            });
          }

          default:
            return {
              content: [
                {
                  type: 'text',
                  text: `## Error\n\nInvalid action: ${action}\n\n**Valid actions:** click, type, press, hover`,
                },
              ],
              isError: true,
            };
        }
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
