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
  action: z.enum(['click', 'type', 'press', 'hover', 'focus', 'focusNext', 'focusPrevious'])
    .describe('Input action: click (click element), type (type text into element), press (press keyboard key), hover (hover over element), focus (focus element by selector), focusNext (Tab to next focusable element), focusPrevious (Shift+Tab to previous focusable element)'),
  connectionReason: z.string().describe('Connection reference (use the reference from launchChrome output, e.g., "unnamed-connection-default" or your renamed tab)'),

  // click, type, hover, focus parameters
  selector: z.string().optional().describe('CSS selector (required for click, type, hover, focus actions). Supports extended selectors: :has-text("text") for partial match, :text("text") for exact match. Example: button:has-text("Submit")'),
  handleModals: z.boolean().optional().describe('Auto-dismiss modals before action (for click, type, hover actions, default: false)'),
  dismissStrategy: z.enum(['accept', 'reject', 'close', 'remove', 'auto']).optional().describe('Strategy to use when dismissing modals if handleModals is true (for click, type, hover actions, default: auto)'),

  // click parameters
  clickCount: z.number().optional().describe('Number of clicks (for click action, default: 1)'),

  // type parameters
  text: z.string().optional().describe('Text to type (required for type action)'),
  delay: z.number().optional().describe('Delay between keystrokes in ms (for type action, default: 0)'),

  // press parameters
  key: z.string().optional().describe('Key to press (required for press action)'),

  // focusNext/focusPrevious parameters
  count: z.number().optional().describe('Number of times to tab (for focusNext/focusPrevious actions, default: 1)'),
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

                // Wait a moment for any UI changes
                await new Promise((resolve) => setTimeout(resolve, 100));

                // Get post-click state
                const postClickState = await page.evaluate((clickedSelector: string) => {
                  const focused = (globalThis as any).document.activeElement;
                  let focusInfo = null;
                  if (focused && focused !== (globalThis as any).document.body) {
                    const tag = focused.tagName.toLowerCase();
                    const text = focused.textContent?.trim().substring(0, 30) || '';
                    const ariaLabel = focused.getAttribute('aria-label') || '';
                    const placeholder = focused.getAttribute('placeholder') || '';
                    const type = focused.getAttribute('type') || '';
                    focusInfo = {
                      tag,
                      type: type || undefined,
                      text: text || ariaLabel || placeholder || undefined,
                      isInput: ['input', 'textarea', 'select'].includes(tag),
                    };
                  }

                  // Get tabbable elements
                  const tabbable = Array.from((globalThis as any).document.querySelectorAll(
                    'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'
                  )).filter((el: any) => {
                    const style = (globalThis as any).window.getComputedStyle(el);
                    return style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
                  });

                  // Helper to format element for display
                  const formatEl = (el: any) => {
                    const tag = el.tagName.toLowerCase();
                    const text = el.textContent?.trim().substring(0, 20) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
                    const type = el.getAttribute('type');
                    if (tag === 'input') {
                      return `${tag}[${type || 'text'}]${text ? ` "${text}"` : ''}`;
                    }
                    return `${tag}${text ? ` "${text}"` : ''}`;
                  };

                  let prevTabbable: string[] = [];
                  let nextTabbable: string[] = [];
                  if (focused) {
                    const currentIndex = tabbable.indexOf(focused);
                    if (currentIndex !== -1) {
                      // Previous 5 tabbable elements
                      prevTabbable = tabbable.slice(Math.max(0, currentIndex - 5), currentIndex).map(formatEl);
                      // Next 5 tabbable elements
                      nextTabbable = tabbable.slice(currentIndex + 1, currentIndex + 6).map(formatEl);
                    }
                  }

                  // Get child interactive elements of clicked element
                  let childInteractive: string[] = [];
                  try {
                    const clickedEl = (globalThis as any).document.querySelector(clickedSelector);
                    if (clickedEl) {
                      const children = clickedEl.querySelectorAll('a[href], button, input, select, textarea');
                      childInteractive = Array.from(children).slice(0, 10).map((el: any) => formatEl(el));
                    }
                  } catch (e) {
                    // Selector may have been cleaned up, ignore
                  }

                  return {
                    focusInfo,
                    prevTabbable,
                    nextTabbable,
                    childInteractive,
                    url: (globalThis as any).window.location.href,
                  };
                }, selector);

                return {
                  selector,
                  clickCount,
                  hasClickHandler,
                  postClickState,
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

            // Build post-click info string
            const postClick = result.result.postClickState;
            let postClickInfo = '';
            if (postClick?.focusInfo) {
              const f = postClick.focusInfo;
              if (f.isInput) {
                postClickInfo = `\n**Focus:** ${f.tag}${f.type ? `[type="${f.type}"]` : ''} ${f.text ? `"${f.text}"` : ''}`;
              } else if (f.tag !== 'body') {
                postClickInfo = `\n**Focus:** ${f.tag}${f.text ? ` "${f.text}"` : ''}`;
              }
            }
            if (postClick?.prevTabbable?.length > 0) {
              postClickInfo += `\n**Prev tab:** ${postClick.prevTabbable.join(' ← ')}`;
            }
            if (postClick?.nextTabbable?.length > 0) {
              postClickInfo += `\n**Next tab:** ${postClick.nextTabbable.join(' → ')}`;
            }
            if (postClick?.childInteractive?.length > 0) {
              postClickInfo += `\n**Contains:** ${postClick.childInteractive.join(', ')}`;
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
                    text: `Clicked element \`${rawSelector}\`${postClickInfo}\n\n**Warning:** ${selectorWarning}`,
                  },
                ],
              };
            }

            // Default success response with post-click info
            if (postClickInfo) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Clicked element: \`${rawSelector}\`${postClickInfo}`,
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

          case 'focus': {
            const { selector: rawSelector } = args;

            if (!rawSelector) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `## Error\n\nMissing required parameter: \`selector\`\n\n**Action:** focus\n\n**Suggestion:** Provide a CSS selector for the element to focus.`,
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

                // Focus the element
                await page.focus(selector);

                // Get focused element info
                const focusInfo = await getFocusedElementInfo(page);

                return { selector, focusInfo };
              },
              'focus'
            );

            // Clean up temporary selector attribute
            await cleanupResolvedSelector(page, selector);

            if (result.result?.error) {
              return createErrorResponse('ELEMENT_NOT_FOUND', { selector: rawSelector });
            }

            const focusInfo = result.result?.focusInfo;
            let response = formatFocusInfo(focusInfo);

            if (selectorWarning) {
              response += `\n\n**Warning:** ${selectorWarning}`;
            }

            return {
              content: [{ type: 'text', text: response }],
            };
          }

          case 'focusNext': {
            const { count = 1 } = args;

            const result = await executeWithPauseDetection(
              targetCdpManager,
              async () => {
                // Press Tab count times
                for (let i = 0; i < count; i++) {
                  await page.keyboard.press('Tab');
                  // Small delay between tabs for stability
                  if (i < count - 1) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                  }
                }

                // Get focused element info
                const focusInfo = await getFocusedElementInfo(page);
                return { focusInfo, tabCount: count };
              },
              'focusNext'
            );

            const focusInfo = result.result?.focusInfo;
            const header = `Tabbed forward${count > 1 ? ` ${count} times` : ''}`;
            const focusOutput = formatFocusInfo(focusInfo, 'No element focused (may have reached end of page)');

            return {
              content: [{ type: 'text', text: `${header}\n\n${focusOutput}` }],
            };
          }

          case 'focusPrevious': {
            const { count = 1 } = args;

            const result = await executeWithPauseDetection(
              targetCdpManager,
              async () => {
                // Press Shift+Tab count times
                for (let i = 0; i < count; i++) {
                  await page.keyboard.down('Shift');
                  await page.keyboard.press('Tab');
                  await page.keyboard.up('Shift');
                  // Small delay between tabs for stability
                  if (i < count - 1) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                  }
                }

                // Get focused element info
                const focusInfo = await getFocusedElementInfo(page);
                return { focusInfo, tabCount: count };
              },
              'focusPrevious'
            );

            const focusInfo = result.result?.focusInfo;
            const header = `Tabbed backward${count > 1 ? ` ${count} times` : ''}`;
            const focusOutput = formatFocusInfo(focusInfo, 'No element focused (may have reached start of page)');

            return {
              content: [{ type: 'text', text: `${header}\n\n${focusOutput}` }],
            };
          }

          default:
            return {
              content: [
                {
                  type: 'text',
                  text: `## Error\n\nInvalid action: ${action}\n\n**Valid actions:** click, type, press, hover, focus, focusNext, focusPrevious`,
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
 * Format focus info into a consistent output string
 */
function formatFocusInfo(focusInfo: {
  description: string;
  selector?: string;
  prevTabbable: string[];
  nextTabbable: string[];
} | null | undefined, noFocusMessage?: string): string {
  if (!focusInfo) {
    return noFocusMessage || 'No element focused';
  }

  let output = `**Focused:** ${focusInfo.description}`;
  if (focusInfo.selector) {
    output += `\n**Selector:** \`${focusInfo.selector}\``;
  }
  if (focusInfo.prevTabbable.length > 0) {
    output += `\n**Prev tab:** ${focusInfo.prevTabbable.join(' ← ')}`;
  }
  if (focusInfo.nextTabbable.length > 0) {
    output += `\n**Next tab:** ${focusInfo.nextTabbable.join(' → ')}`;
  }
  return output;
}

/**
 * Helper function to get information about the currently focused element
 */
async function getFocusedElementInfo(page: any): Promise<{
  description: string;
  tag: string;
  type?: string;
  text?: string;
  selector?: string;
  prevTabbable: string[];
  nextTabbable: string[];
} | null> {
  return await page.evaluate(() => {
    const focused = (globalThis as any).document.activeElement;
    if (!focused || focused === (globalThis as any).document.body) {
      return null;
    }

    const tag = focused.tagName.toLowerCase();
    const type = focused.getAttribute('type') || undefined;
    const text = focused.textContent?.trim().substring(0, 50) ||
      focused.getAttribute('aria-label') ||
      focused.getAttribute('placeholder') ||
      focused.getAttribute('name') ||
      focused.getAttribute('id') ||
      '';

    // Build a description
    let description = tag;
    if (type) description += `[type="${type}"]`;
    if (text) description += ` "${text}"`;

    // Try to build a useful selector
    let selector: string | undefined;
    if (focused.id) {
      selector = `#${focused.id}`;
    } else if (focused.name) {
      selector = `${tag}[name="${focused.name}"]`;
    } else if (focused.className && typeof focused.className === 'string') {
      const classes = focused.className.trim().split(/\s+/).slice(0, 2).join('.');
      if (classes) selector = `${tag}.${classes}`;
    }

    // Helper to format element for display
    const formatEl = (el: any) => {
      const elTag = el.tagName.toLowerCase();
      const elText = el.textContent?.trim().substring(0, 20) ||
        el.getAttribute('aria-label') ||
        el.getAttribute('placeholder') ||
        '';
      const elType = el.getAttribute('type');
      if (elTag === 'input') {
        return `${elTag}[${elType || 'text'}]${elText ? ` "${elText}"` : ''}`;
      }
      return `${elTag}${elText ? ` "${elText}"` : ''}`;
    };

    // Get tabbable elements
    const tabbable = Array.from((globalThis as any).document.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter((el: any) => {
      const style = (globalThis as any).window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });

    const currentIndex = tabbable.indexOf(focused);
    let prevTabbable: string[] = [];
    let nextTabbable: string[] = [];

    if (currentIndex !== -1) {
      // Previous 3 tabbable elements
      prevTabbable = tabbable.slice(Math.max(0, currentIndex - 3), currentIndex).map(formatEl);
      // Next 3 tabbable elements
      nextTabbable = tabbable.slice(currentIndex + 1, currentIndex + 4).map(formatEl);
    }

    return {
      description,
      tag,
      type,
      text: text || undefined,
      selector,
      prevTabbable,
      nextTabbable,
    };
  });
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
