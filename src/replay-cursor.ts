/**
 * Replay cursor overlay for visual feedback during interaction replay
 */

import type { Page } from 'puppeteer-core';

/**
 * Inject the replay cursor overlay into the page
 */
export async function injectReplayCursor(page: Page): Promise<void> {
  await page.evaluate(() => {
    const doc = (globalThis as any).document;

    // Remove existing cursor if any
    const existing = doc.getElementById('__cdp-replay-cursor');
    if (existing) existing.remove();

    // Create cursor element
    const cursor = doc.createElement('div');
    cursor.id = '__cdp-replay-cursor';
    cursor.innerHTML = `
      <div class="cdp-cursor-pointer">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M5.5 3.21V20.8C5.5 21.51 6.37 21.88 6.88 21.37L10.73 17.52L14.25 22.5L17.5 20.5L14 15.5H19.5C20.21 15.5 20.58 14.63 20.07 14.12L6.08 3.08C5.57 2.57 5.5 2.5 5.5 3.21Z" fill="black" stroke="white" stroke-width="1.5"/>
        </svg>
      </div>
      <div class="cdp-cursor-ripple"></div>
    `;

    const style = doc.createElement('style');
    style.id = '__cdp-replay-cursor-style';
    style.textContent = `
      #__cdp-replay-cursor {
        position: fixed;
        pointer-events: none;
        z-index: 2147483647;
        transition: left 0.15s ease-out, top 0.15s ease-out;
        left: 0;
        top: 0;
      }

      .cdp-cursor-pointer {
        transition: transform 0.1s;
      }

      .cdp-cursor-pointer.clicking {
        transform: scale(0.9);
      }

      .cdp-cursor-pointer svg path {
        transition: fill 0.1s;
      }

      .cdp-cursor-pointer.right-click svg path {
        fill: #ef4444;
      }

      .cdp-cursor-ripple {
        position: absolute;
        top: 4px;
        left: 4px;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        pointer-events: none;
        opacity: 0;
      }

      .cdp-cursor-ripple.active {
        animation: cdp-ripple 0.4s ease-out forwards;
      }

      .cdp-cursor-ripple.left {
        border: 2px solid #22c55e;
      }

      .cdp-cursor-ripple.right {
        border: 2px solid #ef4444;
      }

      @keyframes cdp-ripple {
        0% {
          width: 16px;
          height: 16px;
          opacity: 1;
        }
        100% {
          width: 60px;
          height: 60px;
          opacity: 0;
        }
      }
    `;

    doc.head.appendChild(style);
    doc.body.appendChild(cursor);

    // Store reference for later access
    (globalThis as any).__cdpReplayCursor = cursor;
  });
}

/**
 * Move the cursor to a position
 */
export async function moveCursor(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(({ x, y }) => {
    const doc = (globalThis as any).document;
    const cursor = doc.getElementById('__cdp-replay-cursor');
    if (cursor) {
      cursor.style.left = `${x}px`;
      cursor.style.top = `${y}px`;
    }
  }, { x, y });
}

/**
 * Show click effect (ripple and dot animation)
 * Moves cursor to position first, waits for animation, then shows click effect
 * @param isRightClick - true for right click (red), false for left click (green)
 */
export async function showClickEffect(page: Page, x: number, y: number, isRightClick: boolean = false): Promise<void> {
  // First move the cursor to the target position
  await page.evaluate(({ x, y }) => {
    const doc = (globalThis as any).document;
    const cursor = doc.getElementById('__cdp-replay-cursor');
    if (cursor) {
      cursor.style.left = `${x}px`;
      cursor.style.top = `${y}px`;
    }
  }, { x, y });

  // Wait for the cursor movement animation (150ms transition + small buffer)
  await new Promise(resolve => setTimeout(resolve, 180));

  // Then show the click effect
  await page.evaluate(({ isRightClick }) => {
    const doc = (globalThis as any).document;
    const cursor = doc.getElementById('__cdp-replay-cursor');
    if (!cursor) return;

    const pointer = cursor.querySelector('.cdp-cursor-pointer') as any;
    const ripple = cursor.querySelector('.cdp-cursor-ripple') as any;

    if (pointer) {
      pointer.classList.add('clicking');
      if (isRightClick) {
        pointer.classList.add('right-click');
      }

      setTimeout(() => {
        pointer.classList.remove('clicking');
        if (isRightClick) {
          pointer.classList.remove('right-click');
        }
      }, 150);
    }

    if (ripple) {
      // Reset ripple
      ripple.classList.remove('active', 'left', 'right');
      ripple.offsetHeight; // Force reflow

      // Add appropriate class and trigger animation
      ripple.classList.add('active', isRightClick ? 'right' : 'left');

      // Remove classes after animation
      setTimeout(() => {
        ripple.classList.remove('active', 'left', 'right');
      }, 400);
    }
  }, { isRightClick });
}

/**
 * Show key press indicator
 */
export async function showKeyPress(page: Page, key: string): Promise<void> {
  await page.evaluate((key) => {
    const doc = (globalThis as any).document;

    // Remove existing key indicator
    const existing = doc.getElementById('__cdp-replay-key');
    if (existing) existing.remove();

    const indicator = doc.createElement('div');
    indicator.id = '__cdp-replay-key';
    indicator.textContent = key.length === 1 ? key : `[${key}]`;
    indicator.style.cssText = `
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0, 0, 0, 0.8);
      color: white;
      padding: 8px 16px;
      border-radius: 8px;
      font-family: monospace;
      font-size: 14px;
      z-index: 2147483647;
      pointer-events: none;
      animation: cdp-key-fade 1.5s ease-out forwards;
    `;

    // Add animation keyframes if not already present
    if (!doc.getElementById('__cdp-key-style')) {
      const style = doc.createElement('style');
      style.id = '__cdp-key-style';
      style.textContent = `
        @keyframes cdp-key-fade {
          0% { opacity: 1; transform: translateX(-50%) translateY(0); }
          80% { opacity: 1; }
          100% { opacity: 0; transform: translateX(-50%) translateY(-10px); }
        }
      `;
      doc.head.appendChild(style);
    }

    doc.body.appendChild(indicator);

    // Remove after animation
    setTimeout(() => {
      indicator.remove();
    }, 1500);
  }, key);
}

/**
 * Remove the replay cursor overlay
 */
export async function removeReplayCursor(page: Page): Promise<void> {
  await page.evaluate(() => {
    const doc = (globalThis as any).document;
    const cursor = doc.getElementById('__cdp-replay-cursor');
    const style = doc.getElementById('__cdp-replay-cursor-style');
    const keyStyle = doc.getElementById('__cdp-key-style');
    const keyIndicator = doc.getElementById('__cdp-replay-key');

    if (cursor) cursor.remove();
    if (style) style.remove();
    if (keyStyle) keyStyle.remove();
    if (keyIndicator) keyIndicator.remove();

    delete (globalThis as any).__cdpReplayCursor;
  });
}
