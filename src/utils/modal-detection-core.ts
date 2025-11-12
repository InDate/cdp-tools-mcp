/**
 * Core modal detection utilities
 *
 * This module contains the fundamental logic for detecting modals and overlays
 * on web pages. It uses a combination of:
 * - Visual analysis (position, z-index, viewport coverage)
 * - DOM structure analysis (ARIA attributes, common patterns)
 * - Reverse detection (elementFromPoint for accuracy)
 *
 * NOTE: Functions in this file are serialized and executed in browser context.
 * We use `as any` type assertions because these functions access DOM APIs
 * (window, document, Element) that aren't available in Node.js types.
 * At runtime, these functions execute in the browser where DOM APIs exist.
 */

export interface ModalDetectionOptions {
  minZIndex?: number;
  minViewportCoverage?: number;
  includeBackdrops?: boolean;
}

export interface DetectedModalInfo {
  selector: string;
  type: ModalType;
  zIndex: number;
  boundingBox: BoundingBox;
  dismissStrategies: DismissStrategy[];
  confidence: number;
  description: string;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
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

export interface ModalPatterns {
  cookieConsent: {
    selectors: string[];
    textPatterns: RegExp;
  };
  newsletter: {
    selectors: string[];
    textPatterns: RegExp;
  };
  ageVerification: {
    selectors: string[];
    textPatterns: RegExp;
  };
  genericDialog: {
    selectors: string[];
    textPatterns: RegExp | null;
  };
}

/**
 * Common modal/dialog selectors and patterns
 */
export const MODAL_PATTERNS: ModalPatterns = {
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

/**
 * Common selectors for finding modal elements
 */
export const COMMON_MODAL_SELECTORS = [
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

/**
 * Browser-side modal detection types
 * These types are used within page.evaluate() context
 */
export interface BrowserModalInfo {
  selector: string;
  type: string;
  zIndex: number;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  dismissStrategies: string[];
  confidence: number;
  description: string;
}

/**
 * Check if element meets basic visibility criteria
 * Runs in browser context via page.evaluate()
 */
export function isBasicVisible(el: any): boolean {
  const style = (globalThis as any).window.getComputedStyle(el);

  if (style.display === 'none') return false;
  if (style.visibility === 'hidden') return false;
  if (parseFloat(style.opacity) < 0.1) return false;

  return true;
}

/**
 * Check if element is positioned to block viewport
 * Runs in browser context via page.evaluate()
 */
export function isBlockingPosition(el: any): boolean {
  const style = (globalThis as any).window.getComputedStyle(el);
  const position = style.position;

  return position === 'fixed' || position === 'absolute';
}

/**
 * Check if element has sufficient z-index
 * Runs in browser context via page.evaluate()
 */
export function hasMinimumZIndex(el: any, minZIndex: number): boolean {
  const style = (globalThis as any).window.getComputedStyle(el);
  const zIndex = parseInt(style.zIndex, 10);

  if (isNaN(zIndex)) return true; // No z-index set, might still be on top

  return zIndex >= minZIndex;
}

/**
 * Check if element covers sufficient viewport area
 * Runs in browser context via page.evaluate()
 */
export function coversMinimumViewport(el: any, minCoverage: number): boolean {
  const rect = el.getBoundingClientRect();
  const viewportArea = (globalThis as any).window.innerWidth * (globalThis as any).window.innerHeight;
  const elementArea = rect.width * rect.height;
  const coverage = elementArea / viewportArea;

  return coverage >= minCoverage;
}

/**
 * Check if element is actually visible on top using elementFromPoint
 * This is the most reliable method - it verifies the element is truly on top
 * Runs in browser context via page.evaluate()
 */
export function isVisibleOnTop(el: any): boolean {
  const rect = el.getBoundingClientRect();

  // Check center point
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;

  // Check if center is in viewport
  if (centerX < 0 || centerX > (globalThis as any).window.innerWidth || centerY < 0 || centerY > (globalThis as any).window.innerHeight) {
    return false;
  }

  const topElement = (globalThis as any).document.elementFromPoint(centerX, centerY);

  if (!topElement) return false;

  // Element is on top if the top element is the element itself or a child
  return topElement === el || el.contains(topElement);
}

/**
 * Combined check: is element blocking the viewport?
 * Uses all visibility checks including elementFromPoint for accuracy
 * Runs in browser context via page.evaluate()
 */
export function isElementBlockingViewport(
  el: any,
  minZIndex: number,
  minViewportCoverage: number
): boolean {
  if (!isBasicVisible(el)) return false;
  if (!isBlockingPosition(el)) return false;
  if (!hasMinimumZIndex(el, minZIndex)) return false;
  if (!coversMinimumViewport(el, minViewportCoverage)) return false;
  if (!isVisibleOnTop(el)) return false;

  return true;
}

/**
 * Classify modal type based on content and attributes
 * Runs in browser context via page.evaluate()
 */
export function classifyModal(el: any, patterns: ModalPatterns): {
  type: string;
  confidence: number;
  description: string;
} {
  const text = el.textContent?.toLowerCase() || '';
  const className = el.className?.toLowerCase() || '';
  const id = el.id?.toLowerCase() || '';

  // Cookie consent detection
  const matchesCookieSelector = patterns.cookieConsent.selectors.some(sel => {
    try {
      return el.matches(sel);
    } catch {
      return false;
    }
  });

  const matchesCookieText = patterns.cookieConsent.textPatterns.test(text) ||
                           patterns.cookieConsent.textPatterns.test(className) ||
                           patterns.cookieConsent.textPatterns.test(id);

  if (matchesCookieSelector || matchesCookieText) {
    return {
      type: 'cookie-consent',
      confidence: 90,
      description: 'Cookie consent banner',
    };
  }

  // Newsletter popup detection
  const matchesNewsletterSelector = patterns.newsletter.selectors.some(sel => {
    try {
      return el.matches(sel);
    } catch {
      return false;
    }
  });

  const matchesNewsletterText = patterns.newsletter.textPatterns.test(text);

  if (matchesNewsletterSelector || matchesNewsletterText) {
    return {
      type: 'newsletter-popup',
      confidence: 85,
      description: 'Newsletter subscription popup',
    };
  }

  // Age verification detection
  const matchesAgeSelector = patterns.ageVerification.selectors.some(sel => {
    try {
      return el.matches(sel);
    } catch {
      return false;
    }
  });

  const matchesAgeText = patterns.ageVerification.textPatterns.test(text);

  if (matchesAgeSelector || matchesAgeText) {
    return {
      type: 'age-verification',
      confidence: 95,
      description: 'Age verification dialog',
    };
  }

  // Generic dialog with ARIA attributes
  if (el.getAttribute('role') === 'dialog' || el.getAttribute('aria-modal') === 'true') {
    return {
      type: 'generic-dialog',
      confidence: 75,
      description: 'Generic modal dialog',
    };
  }

  // Backdrop/overlay (usually paired with modal)
  if ((className.includes('backdrop') ||
       className.includes('overlay') ||
       id.includes('backdrop') ||
       id.includes('overlay')) &&
      !text.trim()) {
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

/**
 * Determine dismissal strategies available for a modal
 * Runs in browser context via page.evaluate()
 */
export function getDismissStrategies(el: any, modalType: string): string[] {
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
    const className = btn.className?.toLowerCase() || '';
    const combined = `${text} ${ariaLabel} ${className}`;

    if (/accept|agree|allow|enable|ok|got it|i accept/i.test(combined) ||
        btn.matches('[class*="accept" i], [id*="accept" i]')) {
      strategies.add('accept');
    }

    if (/reject|decline|deny|disable|no thanks|refuse/i.test(combined) ||
        btn.matches('[class*="reject" i], [id*="reject" i], [class*="decline" i]')) {
      strategies.add('reject');
    }

    if (/close|dismiss|×|✕|✖/i.test(combined) ||
        btn.matches('[class*="close" i], [class*="dismiss" i], .close, .dismiss')) {
      strategies.add('close');
    }
  });

  // Type-specific defaults
  if (modalType === 'cookie-consent' && !strategies.has('accept')) {
    strategies.add('accept');
  }

  return Array.from(strategies);
}

/**
 * Generate unique CSS selector for an element
 * Runs in browser context via page.evaluate()
 */
export function getUniqueSelector(el: any): string {
  // Try ID first
  if (el.id) {
    return `#${el.id}`;
  }

  // Try unique class combinations
  if (el.className && typeof el.className === 'string') {
    const classes = el.className.split(/\s+/).filter(Boolean);
    if (classes.length > 0) {
      const selector = `.${classes.join('.')}`;
      if ((globalThis as any).document.querySelectorAll(selector).length === 1) {
        return selector;
      }
    }
  }

  // Build path-based selector
  const path: string[] = [];
  let current: any = el;

  while (current && current !== (globalThis as any).document.body) {
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
