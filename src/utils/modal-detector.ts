// @ts-nocheck
/**
 * TypeScript checking is disabled for this file because it contains browser-side code
 * within page.evaluate() callbacks. The code inside evaluate() runs in the browser context,
 * not in Node.js, so TypeScript cannot properly type-check the DOM APIs, window object,
 * and other browser-specific globals that are available there.
 */
import type { Page } from 'puppeteer-core';
import { debugLog } from '../debug-logger.js';

export interface DetectedModal {
  selector: string;
  type: ModalType;
  zIndex: number;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  dismissStrategies: DismissStrategy[];
  confidence: number; // 0-100
  description: string;
}

export type ModalType =
  | 'cookie-consent'
  | 'newsletter-popup'
  | 'age-verification'
  | 'generic-dialog'
  | 'blocking-overlay'
  | 'unknown';

export type DismissStrategy =
  | 'accept'
  | 'reject'
  | 'close'
  | 'remove';

export interface ModalDetectionOptions {
  minZIndex?: number; // Default: 100
  minViewportCoverage?: number; // Default: 0.25 (25%)
  includeBackdrops?: boolean; // Default: true
}

/**
 * Detects modals and blocking overlays on the page
 */
export async function detectModals(
  page: Page,
  options: ModalDetectionOptions = {}
): Promise<DetectedModal[]> {
  const {
    minZIndex = 100,
    minViewportCoverage = 0.25,
    includeBackdrops = true,
  } = options;

  // Debug: log page URL before evaluate
  const pageUrl = page.url();
  await debugLog('ModalDetector', `About to evaluate on page: ${pageUrl}`);
  await debugLog('ModalDetector', `Options: minZIndex=${minZIndex}, minViewportCoverage=${minViewportCoverage}, includeBackdrops=${includeBackdrops}`);

  const modals = await page.evaluate((opts: any) => {
    const { minZIndex, minViewportCoverage, includeBackdrops } = opts;
    const detectedModals: any[] = [];

    // Common modal/dialog selectors and patterns
    const modalPatterns = {
      cookieConsent: {
        selectors: [
          '[class*="cookie" i][class*="banner" i]',
          '[class*="cookie" i][class*="consent" i]',
          '[class*="cookie" i][class*="notice" i]',
          '[id*="cookie" i][id*="banner" i]',
          '[id*="cookie" i][id*="consent" i]',
          '#onetrust-banner-sdk',
          '#cookiescript_injected',
          '.cookie-banner',
          '.cc-banner',
          '.cookie-consent',
        ],
        textPatterns: /cookie|consent|privacy|gdpr/i,
      },
      newsletter: {
        selectors: [
          '[class*="newsletter" i][class*="popup" i]',
          '[class*="newsletter" i][class*="modal" i]',
          '[class*="subscribe" i][class*="popup" i]',
          '[class*="email" i][class*="signup" i]',
          '[id*="newsletter" i][id*="popup" i]',
        ],
        textPatterns: /newsletter|subscribe|sign up|email|join/i,
      },
      ageVerification: {
        selectors: [
          '[class*="age" i][class*="verify" i]',
          '[class*="age" i][class*="gate" i]',
          '[id*="age" i][id*="verify" i]',
        ],
        textPatterns: /age verification|are you.*old|18\+|21\+|enter.*birth/i,
      },
      genericDialog: {
        selectors: [
          '[role="dialog"]',
          '[aria-modal="true"]',
          '.modal',
          '.dialog',
          '[class*="modal" i]',
          '[class*="dialog" i]',
          '[class*="popup" i]',
        ],
        textPatterns: null,
      },
    };

    // Helper to check if element is visible and blocking
    function isElementBlockingViewport(el: Element): boolean {
      const style = window.getComputedStyle(el);

      // Check basic visibility
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        parseFloat(style.opacity) < 0.1
      ) {
        return false;
      }

      // Check if element has blocking potential
      const position = style.position;
      if (position !== 'fixed' && position !== 'absolute') {
        return false;
      }

      // Check z-index
      const zIndex = parseInt(style.zIndex, 10);
      if (!isNaN(zIndex) && zIndex < minZIndex) {
        return false;
      }

      // Check viewport coverage
      const rect = el.getBoundingClientRect();
      const viewportArea = window.innerWidth * window.innerHeight;
      const elementArea = rect.width * rect.height;
      const coverage = elementArea / viewportArea;

      return coverage >= minViewportCoverage;
    }

    // Helper to classify modal type
    function classifyModal(el: Element): { type: string; confidence: number; description: string } {
      const text = el.textContent?.toLowerCase() || '';
      const html = el.innerHTML.toLowerCase();
      const className = el.className.toLowerCase();
      const id = el.id.toLowerCase();

      // Cookie consent detection
      if (
        modalPatterns.cookieConsent.selectors.some(sel => {
          try { return el.matches(sel); } catch { return false; }
        }) ||
        modalPatterns.cookieConsent.textPatterns.test(text) ||
        modalPatterns.cookieConsent.textPatterns.test(className) ||
        modalPatterns.cookieConsent.textPatterns.test(id)
      ) {
        return {
          type: 'cookie-consent',
          confidence: 90,
          description: 'Cookie consent banner',
        };
      }

      // Newsletter popup detection
      if (
        modalPatterns.newsletter.selectors.some(sel => {
          try { return el.matches(sel); } catch { return false; }
        }) ||
        modalPatterns.newsletter.textPatterns.test(text)
      ) {
        return {
          type: 'newsletter-popup',
          confidence: 85,
          description: 'Newsletter subscription popup',
        };
      }

      // Age verification detection
      if (
        modalPatterns.ageVerification.selectors.some(sel => {
          try { return el.matches(sel); } catch { return false; }
        }) ||
        modalPatterns.ageVerification.textPatterns.test(text)
      ) {
        return {
          type: 'age-verification',
          confidence: 95,
          description: 'Age verification dialog',
        };
      }

      // Generic dialog with ARIA attributes
      if (
        el.getAttribute('role') === 'dialog' ||
        el.getAttribute('aria-modal') === 'true'
      ) {
        return {
          type: 'generic-dialog',
          confidence: 75,
          description: 'Generic modal dialog',
        };
      }

      // Backdrop/overlay (usually paired with modal)
      if (
        (className.includes('backdrop') ||
          className.includes('overlay') ||
          id.includes('backdrop') ||
          id.includes('overlay')) &&
        !text.trim()
      ) {
        return {
          type: 'blocking-overlay',
          confidence: 70,
          description: 'Blocking backdrop/overlay',
        };
      }

      return {
        type: 'unknown',
        confidence: 50,
        description: 'Unknown blocking element',
      };
    }

    // Helper to determine dismiss strategies
    function getDismissStrategies(el: Element, modalType: string): string[] {
      const strategies = new Set<string>();

      // Always allow DOM removal as fallback
      strategies.add('remove');

      // Look for close/dismiss buttons
      const closeButtons = el.querySelectorAll(
        'button, [role="button"], a, .close, .dismiss, [class*="close" i]'
      );

      closeButtons.forEach((btn: any) => {
        const text = (btn.textContent || '').toLowerCase();
        const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
        const className = btn.className.toLowerCase();
        const combined = `${text} ${ariaLabel} ${className}`;

        if (
          /accept|agree|allow|enable|ok|got it|i accept/i.test(combined) ||
          btn.matches('[class*="accept" i], [id*="accept" i]')
        ) {
          strategies.add('accept');
        }

        if (
          /reject|decline|deny|disable|no thanks|refuse/i.test(combined) ||
          btn.matches('[class*="reject" i], [id*="reject" i], [class*="decline" i]')
        ) {
          strategies.add('reject');
        }

        if (
          /close|dismiss|×|✕|✖/i.test(combined) ||
          btn.matches('[class*="close" i], [class*="dismiss" i], .close, .dismiss')
        ) {
          strategies.add('close');
        }
      });

      // Type-specific defaults
      if (modalType === 'cookie-consent' && !strategies.has('accept')) {
        strategies.add('accept'); // Assume there's an accept button
      }

      return Array.from(strategies);
    }

    // Helper to generate unique selector
    function getUniqueSelector(el: Element): string {
      // Try ID first
      if (el.id) {
        return `#${el.id}`;
      }

      // Try unique class combinations
      if (el.className && typeof el.className === 'string') {
        const classes = el.className.split(/\s+/).filter(Boolean);
        if (classes.length > 0) {
          const selector = `.${classes.join('.')}`;
          if (document.querySelectorAll(selector).length === 1) {
            return selector;
          }
        }
      }

      // Build path-based selector
      const path: string[] = [];
      let current: Element | null = el;

      while (current && current !== document.body) {
        let selector = current.tagName.toLowerCase();

        if (current.id) {
          selector += `#${current.id}`;
          path.unshift(selector);
          break;
        }

        if (current.className && typeof current.className === 'string') {
          const classes = current.className.split(/\s+/).filter(Boolean);
          if (classes.length > 0) {
            selector += `.${classes[0]}`;
          }
        }

        path.unshift(selector);
        current = current.parentElement;
      }

      return path.join(' > ');
    }

    // Scan all elements - use a more targeted approach
    // Instead of scanning all elements, look for common modal patterns first
    const commonModalSelectors = [
      '[role="dialog"]',
      '[aria-modal="true"]',
      '[class*="modal" i]',
      '[class*="dialog" i]',
      '[class*="popup" i]',
      '[class*="overlay" i]',
      '[class*="cookie" i]',
      '[id*="modal" i]',
      '[id*="dialog" i]',
      '[id*="popup" i]',
      '[id*="cookie" i]',
    ];

    const candidateElements: Element[] = [];

    // First, try common selectors
    commonModalSelectors.forEach((selector) => {
      try {
        const elements = document.querySelectorAll(selector);
        elements.forEach(el => {
          if (!candidateElements.includes(el) && isElementBlockingViewport(el)) {
            candidateElements.push(el);
          }
        });
      } catch (e) {
        // Ignore selector errors
      }
    });

    // If we found candidates, don't do expensive full scan
    // If no candidates, fall back to scanning all fixed/absolute positioned elements
    if (candidateElements.length === 0) {
      const allFixed = document.querySelectorAll('*');
      allFixed.forEach(el => {
        const style = window.getComputedStyle(el);
        if ((style.position === 'fixed' || style.position === 'absolute') &&
            isElementBlockingViewport(el)) {
          candidateElements.push(el);
        }
      });
    }

    // Process candidates
    // TODO: Add better error handling - errors in classifyModal or getDismissStrategies can fail silently
    candidateElements.forEach((el: any) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const zIndex = parseInt(style.zIndex, 10) || 0;

      const classification = classifyModal(el);
      const strategies = getDismissStrategies(el, classification.type);

      // Filter out backdrops if requested
      if (!includeBackdrops && classification.type === 'blocking-overlay') {
        return;
      }

      detectedModals.push({
        selector: getUniqueSelector(el),
        type: classification.type,
        zIndex,
        boundingBox: {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
        },
        dismissStrategies: strategies,
        confidence: classification.confidence,
        description: classification.description,
      });
    });

    // Sort by z-index (highest first) and confidence
    detectedModals.sort((a, b) => {
      if (b.zIndex !== a.zIndex) {
        return b.zIndex - a.zIndex;
      }
      return b.confidence - a.confidence;
    });

    return detectedModals;
  }, { minZIndex, minViewportCoverage, includeBackdrops });

  await debugLog('ModalDetector', `page.evaluate returned ${modals.length} modals`);
  return modals as DetectedModal[];
}

/**
 * Checks if a specific element is blocked by a modal/overlay
 */
export async function isElementBlocked(
  page: Page,
  selector: string
): Promise<{ blocked: boolean; blockingModal?: DetectedModal }> {
  const result = await page.evaluate((sel: any) => {
    const element = document.querySelector(sel);
    if (!element) {
      return { blocked: false, error: 'Element not found' };
    }

    const rect = element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    // Check what element is at the target's center point
    const topElement = document.elementFromPoint(centerX, centerY);

    if (!topElement) {
      return { blocked: false };
    }

    // If the top element is the target or a child, it's not blocked
    if (topElement === element || element.contains(topElement)) {
      return { blocked: false };
    }

    // Find the blocking element's topmost ancestor that's fixed/absolute
    let blockingElement: Element | null = topElement;
    while (blockingElement && blockingElement !== document.body) {
      const style = window.getComputedStyle(blockingElement);
      const position = style.position;

      if (position === 'fixed' || position === 'absolute') {
        const zIndex = parseInt(style.zIndex, 10) || 0;
        const blockingRect = blockingElement.getBoundingClientRect();

        return {
          blocked: true,
          blockingElement: {
            selector: blockingElement.id
              ? `#${blockingElement.id}`
              : blockingElement.className
                ? `.${blockingElement.className.split(/\s+/)[0]}`
                : blockingElement.tagName.toLowerCase(),
            zIndex,
            boundingBox: {
              x: blockingRect.left,
              y: blockingRect.top,
              width: blockingRect.width,
              height: blockingRect.height,
            },
          },
        };
      }

      blockingElement = blockingElement.parentElement;
    }

    return { blocked: true, blockingElement: null };
  }, selector);

  if (!result.blocked) {
    return { blocked: false };
  }

  // If we found a blocking element, try to classify it
  if (result.blockingElement) {
    const modals = await detectModals(page);
    const matchingModal = modals.find(
      m => m.selector === result.blockingElement.selector
    );

    return {
      blocked: true,
      blockingModal: matchingModal || {
        ...result.blockingElement,
        type: 'unknown' as ModalType,
        dismissStrategies: ['remove'] as DismissStrategy[],
        confidence: 50,
        description: 'Unknown blocking element',
      },
    };
  }

  return { blocked: true };
}
