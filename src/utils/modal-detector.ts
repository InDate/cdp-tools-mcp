/**
 * Modal detection utilities for Puppeteer pages
 *
 * This module provides functions to detect and classify modals on web pages.
 * It uses the core detection logic from modal-detection-core.ts and executes
 * it in the browser context via page.evaluate().
 */

import type { Page } from 'puppeteer-core';
import { debugLog } from '../debug-logger.js';
import type {
  ModalDetectionOptions,
  DetectedModalInfo,
  BrowserModalInfo,
  ModalType,
  DismissStrategy,
  BoundingBox,
} from './modal-detection-core.js';
import {
  MODAL_PATTERNS,
  COMMON_MODAL_SELECTORS,
  isElementBlockingViewport,
  classifyModal,
  getDismissStrategies,
  getUniqueSelector,
} from './modal-detection-core.js';

// Re-export types for backward compatibility
export type { ModalType, DismissStrategy, ModalDetectionOptions };
export interface DetectedModal extends DetectedModalInfo {}

/**
 * Detects modals and blocking overlays on the page
 *
 * This is the fixed implementation that uses elementFromPoint for reliable detection
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

  const pageUrl = page.url();
  await debugLog('ModalDetector', `Detecting modals on page: ${pageUrl}`);
  await debugLog('ModalDetector', `Options: minZIndex=${minZIndex}, minViewportCoverage=${minViewportCoverage}, includeBackdrops=${includeBackdrops}`);

  // Serialize functions and data to pass into browser context
  const modals = await page.evaluate(
    (opts: {
      minZIndex: number;
      minViewportCoverage: number;
      includeBackdrops: boolean;
      modalPatterns: any;
      commonSelectors: string[];
      // Functions as strings to execute in browser
      isElementBlockingViewportFn: string;
      classifyModalFn: string;
      getDismissStrategiesFn: string;
      getUniqueSelectorFn: string;
    }) => {
      const {
        minZIndex,
        minViewportCoverage,
        includeBackdrops,
        modalPatterns,
        commonSelectors,
        isElementBlockingViewportFn,
        classifyModalFn,
        getDismissStrategiesFn,
        getUniqueSelectorFn,
      } = opts;

      // Reconstruct functions in browser context
      // eslint-disable-next-line no-eval
      const isElementBlockingViewportFunc = eval(`(${isElementBlockingViewportFn})`);
      // eslint-disable-next-line no-eval
      const classifyModalFunc = eval(`(${classifyModalFn})`);
      // eslint-disable-next-line no-eval
      const getDismissStrategiesFunc = eval(`(${getDismissStrategiesFn})`);
      // eslint-disable-next-line no-eval
      const getUniqueSelectorFunc = eval(`(${getUniqueSelectorFn})`);

      const detectedModals: any[] = [];
      const candidateElements: any[] = [];

      // Scan using common selectors
      commonSelectors.forEach((selector) => {
        try {
          const elements = (globalThis as any).document.querySelectorAll(selector);
          elements.forEach((el: any) => {
            if (!candidateElements.includes(el) &&
                isElementBlockingViewportFunc(el, minZIndex, minViewportCoverage)) {
              candidateElements.push(el);
            }
          });
        } catch (e) {
          // Ignore selector errors
        }
      });

      // Fallback: scan all fixed/absolute positioned elements if no candidates found
      if (candidateElements.length === 0) {
        const allElements = (globalThis as any).document.querySelectorAll('*');
        allElements.forEach((el: any) => {
          const style = (globalThis as any).window.getComputedStyle(el);
          if ((style.position === 'fixed' || style.position === 'absolute') &&
              isElementBlockingViewportFunc(el, minZIndex, minViewportCoverage)) {
            candidateElements.push(el);
          }
        });
      }

      // Process candidates
      candidateElements.forEach((el: any) => {
        const rect = el.getBoundingClientRect();
        const style = (globalThis as any).window.getComputedStyle(el);
        const zIndex = parseInt(style.zIndex, 10) || 0;

        const classification = classifyModalFunc(el, modalPatterns);
        const strategies = getDismissStrategiesFunc(el, classification.type);

        // Filter out backdrops if requested
        if (!includeBackdrops && classification.type === 'blocking-overlay') {
          return;
        }

        detectedModals.push({
          selector: getUniqueSelectorFunc(el),
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
    },
    {
      minZIndex,
      minViewportCoverage,
      includeBackdrops,
      modalPatterns: MODAL_PATTERNS,
      commonSelectors: COMMON_MODAL_SELECTORS,
      // Serialize functions as strings
      isElementBlockingViewportFn: isElementBlockingViewport.toString(),
      classifyModalFn: classifyModal.toString(),
      getDismissStrategiesFn: getDismissStrategies.toString(),
      getUniqueSelectorFn: getUniqueSelector.toString(),
    }
  );

  await debugLog('ModalDetector', `Detected ${modals.length} modal(s)`);
  return modals as DetectedModal[];
}

/**
 * Checks if a specific element is blocked by a modal/overlay
 *
 * This uses the reverse approach (elementFromPoint) which is more reliable
 * than proactive scanning
 */
export async function isElementBlocked(
  page: Page,
  selector: string
): Promise<{ blocked: boolean; blockingModal?: DetectedModal }> {
  await debugLog('ModalDetector', `Checking if element ${selector} is blocked`);

  const result = await page.evaluate((sel: string) => {
    const element = (globalThis as any).document.querySelector(sel);
    if (!element) {
      return { blocked: false, error: 'Element not found' };
    }

    const rect = element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    // Check what element is at the target's center point
    const topElement = (globalThis as any).document.elementFromPoint(centerX, centerY);

    if (!topElement) {
      return { blocked: false };
    }

    // If the top element is the target or a child, it's not blocked
    if (topElement === element || element.contains(topElement)) {
      return { blocked: false };
    }

    // Find the blocking element's topmost ancestor that's fixed/absolute
    let blockingElement: any = topElement;
    while (blockingElement && blockingElement !== (globalThis as any).document.body) {
      const style = (globalThis as any).window.getComputedStyle(blockingElement);
      const position = style.position;

      if (position === 'fixed' || position === 'absolute') {
        const zIndex = parseInt(style.zIndex, 10) || 0;
        const blockingRect = blockingElement.getBoundingClientRect();

        // Generate selector for blocking element
        let blockingSelector: string;
        if (blockingElement.id) {
          blockingSelector = `#${blockingElement.id}`;
        } else if (blockingElement.className && typeof blockingElement.className === 'string') {
          const classes = blockingElement.className.split(/\s+/).filter(Boolean);
          blockingSelector = classes.length > 0 ? `.${classes[0]}` : blockingElement.tagName.toLowerCase();
        } else {
          blockingSelector = blockingElement.tagName.toLowerCase();
        }

        return {
          blocked: true,
          blockingElement: {
            selector: blockingSelector,
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
    await debugLog('ModalDetector', `Element ${selector} is not blocked`);
    return { blocked: false };
  }

  // If we found a blocking element, try to classify it
  if (result.blockingElement) {
    const modals = await detectModals(page);
    const matchingModal = modals.find(
      m => m.selector === result.blockingElement.selector
    );

    if (matchingModal) {
      await debugLog('ModalDetector', `Element ${selector} is blocked by modal: ${matchingModal.type}`);
      return {
        blocked: true,
        blockingModal: matchingModal,
      };
    } else {
      await debugLog('ModalDetector', `Element ${selector} is blocked by unknown element`);
      return {
        blocked: true,
        blockingModal: {
          ...result.blockingElement,
          type: 'unknown' as ModalType,
          dismissStrategies: ['remove'] as DismissStrategy[],
          confidence: 50,
          description: 'Unknown blocking element',
        },
      };
    }
  }

  await debugLog('ModalDetector', `Element ${selector} is blocked (reason unknown)`);
  return { blocked: true };
}
