import { z } from 'zod';
import type { Page } from 'puppeteer-core';
import {
  detectModals as detectModalsUtil,
  DetectedModal,
  DismissStrategy,
  ModalDetectionOptions,
} from '../utils/modal-detector.js';
import { executeWithPauseDetection } from '../debugger-aware-wrapper.js';
import { formatToolError, formatToolSuccess } from '../messages.js';
import { createTool } from '../validation-helpers.js';

// Zod schemas for input validation
const detectModalsSchema = z.object({
  connectionReason: z.string().describe('Brief reason for needing this browser connection (3 descriptive words recommended, e.g., \'search wikipedia results\', \'test checkout flow\'). Auto-creates/reuses tabs.'),
  minZIndex: z.number().optional().describe('Minimum z-index to consider (default: 100)'),
  minViewportCoverage: z.number().optional().describe('Minimum viewport coverage (0-1, default: 0.25)'),
  includeBackdrops: z.boolean().optional().describe('Include backdrop/overlay elements (default: true)'),
}).strict();

const dismissModalSchema = z.object({
  connectionReason: z.string().describe('Brief reason for needing this browser connection (3 descriptive words recommended, e.g., \'search wikipedia results\', \'test checkout flow\'). Auto-creates/reuses tabs.'),
  selector: z.string().optional().describe('CSS selector of the modal to dismiss'),
  index: z.number().optional().describe('Index of the modal to dismiss (1-based, from detectModals results)'),
  strategy: z.enum(['accept', 'reject', 'close', 'remove', 'auto']).default('auto').describe('Dismissal strategy: accept (click accept/agree), reject (click reject/decline), close (click close/X), remove (remove from DOM), auto (smart selection based on modal type)'),
  retryAttempts: z.number().default(3).describe('Number of retry attempts when clicking buttons (default: 3)'),
}).strict();

/**
 * Create modal handling tools
 */
export function createModalTools(resolveConnectionFromReason: (connectionReason: string) => Promise<any>) {
  return {
    detectModals: createTool(
      'Detects modals and blocking overlays on the current page',
      detectModalsSchema,
      async (args) => await detectModalsImpl(args, resolveConnectionFromReason)
    ),
    dismissModal: createTool(
      'Dismisses a modal using various strategies',
      dismissModalSchema,
      async (args) => await dismissModalImpl(args, resolveConnectionFromReason)
    ),
  };
}

/**
 * Detects modals and blocking overlays on the current page
 */
async function detectModalsImpl(
  args: {
    connectionReason: string;
    minZIndex?: number;
    minViewportCoverage?: number;
    includeBackdrops?: boolean;
  },
  resolveConnectionFromReason: (connectionReason: string) => Promise<any>
) {
  const { connectionReason, ...detectionOptions } = args;

  try {
    const resolved = await resolveConnectionFromReason(connectionReason);
    if (!resolved || !resolved.puppeteerManager) {
      return formatToolError('connection_not_found', 'No Chrome browser available. Use `launchChrome` first to start a browser.');
    }
    const page = resolved.puppeteerManager.getPage();
    const cdpManager = resolved.cdpManager;

    const result = await executeWithPauseDetection(
      cdpManager,
      async () => await detectModalsUtil(page, detectionOptions as ModalDetectionOptions),
      'detectModals'
    );

    const modals = result.result || [];

    if (modals.length === 0) {
      return formatToolSuccess(
        'No blocking modals detected on the page',
        { count: 0 }
      );
    }

    // Get viewport dimensions
    const viewport = page.viewport();
    const viewportWidth = viewport?.width || 1920;
    const viewportHeight = viewport?.height || 1080;

    // Format modals for display
    const formattedModals = modals.map((modal: any, index: number) => ({
      index: index + 1,
      type: modal.type,
      description: modal.description,
      confidence: `${modal.confidence}%`,
      selector: modal.selector,
      zIndex: modal.zIndex,
      position: {
        x: Math.round(modal.boundingBox.x),
        y: Math.round(modal.boundingBox.y),
        width: Math.round(modal.boundingBox.width),
        height: Math.round(modal.boundingBox.height),
      },
      viewportCoverage: `${Math.round(
        (modal.boundingBox.width * modal.boundingBox.height) /
          viewportWidth /
          viewportHeight *
          100
      )}%`,
      availableStrategies: modal.dismissStrategies,
    }));

    return formatToolSuccess(
      `Detected ${modals.length} blocking modal${modals.length > 1 ? 's' : ''}`,
      {
        count: modals.length,
        modals: formattedModals,
        recommendation:
          modals.length > 0
            ? `Use dismissModal with index ${formattedModals[0].index} or selector "${formattedModals[0].selector}"`
            : undefined,
      }
    );
  } catch (error: any) {
    return formatToolError(
      'modal_detection_failed',
      `Failed to detect modals: ${error.message}`
    );
  }
}

/**
 * Dismisses a modal using various strategies
 */
async function dismissModalImpl(
  args: {
    connectionReason: string;
    selector?: string;
    index?: number;
    strategy?: 'accept' | 'reject' | 'close' | 'remove' | 'auto';
    retryAttempts?: number;
  },
  resolveConnectionFromReason: (connectionReason: string) => Promise<any>
) {
  const {
    connectionReason,
    selector,
    index,
    strategy = 'auto',
    retryAttempts = 3,
  } = args;

  try {
    const { page, cdpManager } = await resolveConnectionFromReason(connectionReason);

    // First, detect modals to find the target
    const detectResult = await executeWithPauseDetection(
      cdpManager,
      async () => await detectModalsUtil(page),
      'detectModals'
    );

    const modals = detectResult.result || [];

    if (modals.length === 0) {
      return formatToolError(
        'no_modals_found',
        'No modals detected on the page. Nothing to dismiss.'
      );
    }

    // Determine which modal to dismiss
    let targetModal: DetectedModal | undefined;

    if (selector) {
      // Try to find modal by selector
      targetModal = modals.find((m: any) => m.selector === selector);
      if (!targetModal) {
        // Selector might be more specific, try to match partial
        targetModal = modals.find((m: any) => m.selector.includes(selector) || selector.includes(m.selector));
      }
    } else if (index !== undefined) {
      // Use index (1-based)
      if (index < 1 || index > modals.length) {
        return formatToolError(
          'invalid_modal_index',
          `Invalid modal index ${index}. Detected ${modals.length} modal${modals.length > 1 ? 's' : ''} (indices 1-${modals.length})`
        );
      }
      targetModal = modals[index - 1];
    } else {
      // Default to first/topmost modal
      targetModal = modals[0];
    }

    if (!targetModal) {
      return formatToolError(
        'modal_not_found',
        selector
          ? `Could not find modal matching selector "${selector}". Available modals:\n${modals.map((m: any, i: any) => `${i + 1}. ${m.selector} (${m.description})`).join('\n')}`
          : 'Could not determine which modal to dismiss'
      );
    }

    // Determine dismissal strategy
    let effectiveStrategy: DismissStrategy;

    if (strategy === 'auto') {
      // Smart strategy selection based on modal type
      switch (targetModal.type) {
        case 'cookie-consent':
          // Prefer accept for cookie consents (least friction)
          effectiveStrategy = targetModal.dismissStrategies.includes('accept')
            ? 'accept'
            : targetModal.dismissStrategies.includes('close')
              ? 'close'
              : 'remove';
          break;
        case 'newsletter-popup':
          // Prefer close for newsletters (non-committal)
          effectiveStrategy = targetModal.dismissStrategies.includes('close')
            ? 'close'
            : targetModal.dismissStrategies.includes('reject')
              ? 'reject'
              : 'remove';
          break;
        case 'age-verification':
          // Prefer accept for age gates (necessary)
          effectiveStrategy = targetModal.dismissStrategies.includes('accept')
            ? 'accept'
            : 'remove';
          break;
        default:
          // For unknown modals, prefer close, then remove
          effectiveStrategy = targetModal.dismissStrategies.includes('close')
            ? 'close'
            : 'remove';
      }
    } else {
      // Use specified strategy if available
      if (!targetModal.dismissStrategies.includes(strategy)) {
        return formatToolError(
          'strategy_not_available',
          `Strategy "${strategy}" not available for this modal. Available strategies: ${targetModal.dismissStrategies.join(', ')}`
        );
      }
      effectiveStrategy = strategy;
    }

    // Execute dismissal
    const dismissResult = await executeWithPauseDetection(cdpManager, async () => {
      return await dismissModalByStrategy(
        page,
        targetModal!,
        effectiveStrategy,
        retryAttempts
      );
    }, 'dismissModal');

    const result = dismissResult.result;

    if (result && result.success) {
      return formatToolSuccess(
        `Successfully dismissed ${targetModal.description} using "${effectiveStrategy}" strategy`,
        {
          modalType: targetModal.type,
          strategy: effectiveStrategy,
          selector: targetModal.selector,
          method: result.method,
        }
      );
    } else {
      return formatToolError(
        'dismissal_failed',
        `Failed to dismiss modal: ${result?.error || 'Unknown error'}`,
        {
          modalType: targetModal.type,
          attemptedStrategy: effectiveStrategy,
          selector: targetModal.selector,
        }
      );
    }
  } catch (error: any) {
    return formatToolError(
      'modal_dismissal_failed',
      `Failed to dismiss modal: ${error.message}`
    );
  }
}

/**
 * Helper function to dismiss modal using specific strategy
 *
 * TODO: This is duplicate code - same logic exists in input-tools.ts dismissModalHelper().
 * Should be extracted to a shared utility function in src/utils/modal-dismissal.ts
 * See KNOWN_LIMITATIONS.md "Duplicate Code in Multiple Files" section.
 */
async function dismissModalByStrategy(
  page: Page,
  modal: DetectedModal,
  strategy: DismissStrategy,
  retryAttempts: number
): Promise<{ success: boolean; method?: string; error?: string }> {
  // Remove strategy - just remove from DOM
  if (strategy === 'remove') {
    try {
      await page.evaluate((sel: any) => {
        const element = (globalThis as any).document.querySelector(sel);
        if (element) {
          element.remove();
          return true;
        }
        return false;
      }, modal.selector);

      // Verify removal
      const stillExists = await page.$(modal.selector);
      if (stillExists) {
        return { success: false, error: 'Element still exists after removal attempt' };
      }

      return { success: true, method: 'DOM removal' };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  // Button click strategies - need to find appropriate button
  const buttonSelectors = await page.evaluate(
    (sel: any, strat: any) => {
      const modal = (globalThis as any).document.querySelector(sel);
      if (!modal) return [];

      const selectors: string[] = [];

      // Define button search patterns based on strategy
      // TODO: These button text patterns are English-only. Non-English sites will fail button detection.
      // Workaround: Use strategy: 'remove' for non-English sites.
      // See KNOWN_LIMITATIONS.md "Language Limitations" section for details.
      let textPatterns: RegExp;
      let classPatterns: string[];

      switch (strat) {
        case 'accept':
          textPatterns = /accept|agree|allow|enable|ok|got it|i accept|continue|yes/i;
          classPatterns = ['accept', 'agree', 'allow', 'enable', 'ok', 'continue', 'yes'];
          break;
        case 'reject':
          textPatterns = /reject|decline|deny|disable|no thanks|refuse|dismiss/i;
          classPatterns = ['reject', 'decline', 'deny', 'refuse', 'no'];
          break;
        case 'close':
          textPatterns = /close|dismiss|×|✕|✖|skip|no thanks/i;
          classPatterns = ['close', 'dismiss', 'skip'];
          break;
        default:
          return [];
      }

      // Find buttons within modal
      const buttons = modal.querySelectorAll(
        'button, [role="button"], a[href="#"], .button, .btn, [class*="button" i], [class*="btn" i]'
      );

      buttons.forEach((btn: any, idx: any) => {
        const text = (btn.textContent || '').trim().toLowerCase();
        const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
        const className = btn.className.toLowerCase();
        const id = btn.id.toLowerCase();
        const combined = `${text} ${ariaLabel} ${className} ${id}`;

        // Check text pattern
        if (textPatterns.test(combined)) {
          // Try to create a unique selector
          if (btn.id) {
            selectors.push(`#${btn.id}`);
          } else if (btn.className) {
            const classes = btn.className.split(/\s+/).filter(Boolean);
            if (classes.length > 0) {
              selectors.push(`${sel} .${classes.join('.')}`);
            }
          } else {
            // Fallback to nth-of-type
            selectors.push(`${sel} button:nth-of-type(${idx + 1})`);
          }
        }

        // Check class patterns
        classPatterns.forEach(pattern => {
          if (className.includes(pattern.toLowerCase())) {
            if (btn.id) {
              selectors.push(`#${btn.id}`);
            } else if (btn.className) {
              const classes = btn.className.split(/\s+/).filter(Boolean);
              selectors.push(`${sel} .${classes.join('.')}`);
            }
          }
        });
      });

      return [...new Set(selectors)]; // Remove duplicates
    },
    modal.selector,
    strategy
  );

  // Try each button selector
  for (const btnSelector of buttonSelectors) {
    for (let attempt = 0; attempt < retryAttempts; attempt++) {
      try {
        const button = await page.$(btnSelector);
        if (!button) continue;

        // Click the button
        await button.click();

        // Wait for modal to disappear (with timeout)
        try {
          await page.waitForSelector(modal.selector, { hidden: true, timeout: 1000 });
          return { success: true, method: `Clicked button: ${btnSelector}` };
        } catch (e) {
          // Modal didn't disappear, try next button
          continue;
        }
      } catch (error) {
        // Try next button or retry
        continue;
      }
    }
  }

  // If no buttons worked, fall back to DOM removal
  if (buttonSelectors.length === 0) {
    return {
      success: false,
      error: `No ${strategy} buttons found in modal. Use strategy "remove" to force removal.`,
    };
  }

  return {
    success: false,
    error: `Found ${buttonSelectors.length} potential ${strategy} button(s) but none successfully dismissed the modal`,
  };
}
