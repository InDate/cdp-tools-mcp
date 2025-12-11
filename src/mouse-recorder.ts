/**
 * Mouse Event Recorder
 *
 * Records mouse movements, clicks, wheel events, and other mouse interactions
 * from a browser page for later replay or conversion to test scripts.
 */

import type { Page } from 'puppeteer-core';

export interface ElementInfo {
  tag: string;
  id?: string;
  className?: string;
  text?: string;
  selector?: string;      // Best-effort CSS selector
  isCanvas?: boolean;     // True if element is canvas/webgl
  isInteractive?: boolean; // True if element is button/link/input
  boundingBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface MouseEvent {
  type: 'mousemove' | 'mousedown' | 'mouseup' | 'wheel' | 'click' | 'dblclick';
  x: number;
  y: number;
  timestamp: number;
  button?: number;       // 0=left, 1=middle, 2=right
  buttons?: number;      // Bitmask of pressed buttons
  deltaX?: number;       // For wheel events
  deltaY?: number;       // For wheel events
  deltaZ?: number;       // For wheel events (rare)
  clickCount?: number;   // For click events
  elementInfo?: ElementInfo;
}

export interface KeyboardEvent {
  type: 'keydown' | 'keyup';
  key: string;           // The key value (e.g., 'a', 'Enter', 'Shift')
  code: string;          // Physical key code (e.g., 'KeyA', 'Enter', 'ShiftLeft')
  timestamp: number;
  modifiers?: {
    ctrl?: boolean;
    alt?: boolean;
    shift?: boolean;
    meta?: boolean;
  };
  repeat?: boolean;      // True if key is being held down
  targetInfo?: {
    tag: string;
    id?: string;
    isInput?: boolean;   // True if target is input/textarea
  };
}

export type InputEvent = MouseEvent | KeyboardEvent;

export interface RecordingOptions {
  showOverlay?: boolean;  // Show visual overlay during recording
}

export interface RecordingSession {
  connectionReference: string;
  startTime: number;
  events: InputEvent[];
  isRecording: boolean;
  isPaused: boolean;
}

// Legacy alias
export interface MouseRecordingSession extends RecordingSession {}

// Active recording sessions by connection reference
const activeSessions = new Map<string, MouseRecordingSession>();

// Injected script handle cleanup
const cleanupHandles = new Map<string, () => Promise<void>>();

/**
 * Start recording mouse events on a page
 */
export async function startMouseRecording(
  page: Page,
  connectionReference: string,
  options: RecordingOptions = {}
): Promise<{ success: boolean; error?: string }> {
  // Check if already recording
  if (activeSessions.has(connectionReference)) {
    return { success: false, error: 'Mouse recording already active for this connection' };
  }

  const session: MouseRecordingSession = {
    connectionReference,
    startTime: Date.now(),
    events: [],
    isRecording: true,
    isPaused: false,
  };

  activeSessions.set(connectionReference, session);

  const showOverlay = options.showOverlay ?? true;

  try {
    // Inject event listeners into the page
    await page.evaluate((showOverlayParam: boolean) => {
      // Create global state
      (globalThis as any).__cdpRecordingEvents = [];
      (globalThis as any).__cdpRecordingStart = Date.now();
      (globalThis as any).__cdpRecordingPaused = false;
      (globalThis as any).__cdpRecordingState = 'recording'; // 'recording' | 'paused' | 'completed'

      const doc = (globalThis as any).document;

      // Build selector helper - returns unique selector or undefined
      // Strategy aligned with element-collector.ts getUniqueSelector
      const buildSelector = (el: any): string | undefined => {
        if (!el || el === doc.body || el === doc.documentElement) return undefined;

        const tag = el.tagName?.toLowerCase();

        // 1. ID is always unique and most specific
        if (el.id) return `#${el.id}`;

        // 2. For inputs, use name attribute (stable form identifier)
        if (el.name && (tag === 'input' || tag === 'textarea' || tag === 'select')) {
          const selector = `${tag}[name="${el.name}"]`;
          try {
            if (doc.querySelectorAll(selector).length === 1) return selector;
          } catch (e) { /* invalid selector */ }
        }

        // 3. aria-label is stable and descriptive
        const ariaLabel = el.getAttribute?.('aria-label');
        if (ariaLabel && ariaLabel.length <= 40) {
          const selector = `${tag}[aria-label="${ariaLabel}"]`;
          try {
            if (doc.querySelectorAll(selector).length === 1) return selector;
          } catch (e) { /* invalid selector */ }
        }

        // 4. href for links (prefer short/relative hrefs)
        if (tag === 'a' && el.href) {
          const href = el.getAttribute?.('href');
          if (href && href !== '#' && !href.startsWith('javascript:') && href.length <= 60) {
            const selector = `a[href="${href}"]`;
            try {
              if (doc.querySelectorAll(selector).length === 1) return selector;
            } catch (e) { /* invalid selector */ }
          }
        }

        // 5. Try data-testid and other test attributes
        const dataAttrs = ['data-testid', 'data-test-id', 'data-cy', 'data-id'];
        for (const attr of dataAttrs) {
          const val = el.getAttribute?.(attr);
          if (val) {
            const selector = `${tag}[${attr}="${val}"]`;
            try {
              if (doc.querySelectorAll(selector).length === 1) return selector;
            } catch (e) { /* invalid selector */ }
          }
        }

        // 6. Text-based selector using :has-text() (cdp-tools extended selector)
        const text = el.textContent?.trim();
        if (text && text.length > 0 && text.length <= 30) {
          const escapedText = text.replace(/"/g, '\\"');
          // :has-text is supported by cdp-tools selector resolver
          return `${tag}:has-text("${escapedText}")`;
        }

        // 7. Try class-based selector (filter out hash/generated classes)
        if (el.className && typeof el.className === 'string') {
          const classes = el.className.split(' ').filter((c: string) =>
            c.length > 0 && c.length <= 20 && !c.includes('__') && !c.match(/^[a-z]+-[a-f0-9]+$/i)
          );
          if (classes.length > 0) {
            const selector = `${tag}.${classes.slice(0, 2).join('.')}`;
            try {
              if (doc.querySelectorAll(selector).length === 1) return selector;
            } catch (e) { /* invalid selector */ }
          }
        }

        // 8. No unique selector found - return undefined to fall back to coordinates
        return undefined;
      };

      // Helper to get element info
      const getElementInfo = (el: any): any => {
        if (!el) return undefined;
        const tag = el.tagName?.toLowerCase();
        const rect = el.getBoundingClientRect?.();
        const isCanvas = tag === 'canvas' || tag === 'svg' || el.closest?.('canvas, svg');
        const isInteractive = ['a', 'button', 'input', 'select', 'textarea'].includes(tag) ||
          el.hasAttribute?.('onclick') ||
          (el.hasAttribute?.('role') && ['button', 'link', 'checkbox', 'radio'].includes(el.getAttribute('role')));
        return {
          tag,
          id: el.id || undefined,
          className: typeof el.className === 'string' ? el.className.trim() : undefined,
          text: el.textContent?.trim().substring(0, 50) || el.getAttribute?.('aria-label') || undefined,
          selector: buildSelector(el),
          isCanvas: isCanvas || undefined,
          isInteractive: isInteractive || undefined,
          boundingBox: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } : undefined,
        };
      };

      // Capture mouse event
      const captureMouseEvent = (e: any, type: string) => {
        if ((globalThis as any).__cdpRecordingPaused) return;
        const event: any = {
          type,
          x: e.clientX,
          y: e.clientY,
          timestamp: Date.now(),
          button: e.button,
          buttons: e.buttons,
        };
        if (type === 'wheel') {
          event.deltaX = e.deltaX;
          event.deltaY = e.deltaY;
        }
        if (type === 'click' || type === 'dblclick') {
          event.clickCount = type === 'dblclick' ? 2 : 1;
        }
        event.elementInfo = getElementInfo(e.target);
        (globalThis as any).__cdpRecordingEvents.push(event);
        updateOverlay(event, type);
      };

      // Capture keyboard event
      const captureKeyEvent = (e: any, type: string) => {
        if ((globalThis as any).__cdpRecordingPaused) return;
        // Ignore modifier-only keys for keyup to reduce noise
        if (type === 'keyup' && ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
        const target = e.target;
        const event: any = {
          type,
          key: e.key,
          code: e.code,
          timestamp: Date.now(),
          repeat: e.repeat || undefined,
        };
        if (e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) {
          event.modifiers = {
            ctrl: e.ctrlKey || undefined,
            alt: e.altKey || undefined,
            shift: e.shiftKey || undefined,
            meta: e.metaKey || undefined,
          };
        }
        const tag = target?.tagName?.toLowerCase();
        if (target && tag) {
          event.targetInfo = {
            tag,
            id: target.id || undefined,
            isInput: ['input', 'textarea', 'select'].includes(tag) || target.isContentEditable,
          };
        }
        (globalThis as any).__cdpRecordingEvents.push(event);
        updateOverlay(event, type);
      };

      // Overlay elements
      let overlay: any = null;
      let highlightBox: any = null;
      let lastHighlightedElement: any = null;

      const updateOverlay = (event: any, type: string) => {
        if (!overlay || (globalThis as any).__cdpRecordingState === 'completed') return;
        const events = (globalThis as any).__cdpRecordingEvents;
        const duration = ((Date.now() - (globalThis as any).__cdpRecordingStart) / 1000).toFixed(1);
        const isPaused = (globalThis as any).__cdpRecordingPaused;

        const statsEl = overlay.querySelector('.cdp-stats');
        const eventEl = overlay.querySelector('.cdp-event');
        const statusEl = overlay.querySelector('.cdp-status');

        if (statsEl) statsEl.textContent = `${events.length} | ${duration}s`;
        if (statusEl) {
          statusEl.textContent = isPaused ? 'PAUSED' : 'REC';
          statusEl.style.background = isPaused ? '#eab308' : '#ef4444';
        }
        if (eventEl) {
          const isKey = type === 'keydown' || type === 'keyup';
          eventEl.textContent = isKey ? event.key : type.replace('mouse', '').toUpperCase();
          eventEl.style.background = type === 'click' ? '#ef4444' :
                                     type === 'wheel' ? '#3b82f6' :
                                     isKey ? '#10b981' :
                                     type.includes('mouse') ? '#8b5cf6' : '#6b7280';
        }

        // Update highlight for mouse events
        if (event.x !== undefined && event.elementInfo?.boundingBox && highlightBox) {
          const bb = event.elementInfo.boundingBox;
          highlightBox.style.display = 'block';
          highlightBox.style.left = `${bb.x}px`;
          highlightBox.style.top = `${bb.y}px`;
          highlightBox.style.width = `${bb.width}px`;
          highlightBox.style.height = `${bb.height}px`;
          highlightBox.style.borderColor = event.elementInfo?.isCanvas ? '#f59e0b' :
                                            event.elementInfo?.isInteractive ? '#22c55e' : '#6366f1';
        }
      };

      if (showOverlayParam) {
        // Create subtle, compact overlay with buttons
        overlay = doc.createElement('div');
        overlay.id = '__cdp-recording-overlay';
        overlay.innerHTML = `
          <div class="cdp-panel" style="
            position: fixed;
            bottom: 10px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(0, 0, 0, 0.75);
            color: white;
            padding: 6px 12px;
            border-radius: 20px;
            font-family: -apple-system, system-ui, sans-serif;
            font-size: 12px;
            z-index: 2147483647;
            display: flex;
            align-items: center;
            gap: 10px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
            backdrop-filter: blur(4px);
          ">
            <span class="cdp-status" style="
              padding: 2px 6px;
              border-radius: 4px;
              font-size: 10px;
              font-weight: 600;
              background: #ef4444;
              letter-spacing: 0.5px;
            ">REC</span>
            <span class="cdp-stats" style="color: #d1d5db; min-width: 60px;">0 | 0.0s</span>
            <span class="cdp-event" style="
              padding: 2px 8px;
              border-radius: 4px;
              font-size: 10px;
              background: #6b7280;
              min-width: 50px;
              text-align: center;
            ">-</span>
            <div style="display: flex; gap: 4px; margin-left: 6px;">
              <button class="cdp-btn cdp-pause" title="Pause/Resume" style="
                background: #374151;
                border: none;
                color: white;
                width: 24px;
                height: 24px;
                border-radius: 4px;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 10px;
              ">⏸</button>
              <button class="cdp-btn cdp-reset" title="Reset" style="
                background: #374151;
                border: none;
                color: white;
                width: 24px;
                height: 24px;
                border-radius: 4px;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 10px;
              ">↺</button>
              <button class="cdp-btn cdp-done" title="Complete" style="
                background: #059669;
                border: none;
                color: white;
                width: 24px;
                height: 24px;
                border-radius: 4px;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 10px;
              ">✓</button>
            </div>
          </div>
        `;
        doc.body.appendChild(overlay);

        // Button handlers
        const pauseBtn = overlay.querySelector('.cdp-pause');
        const resetBtn = overlay.querySelector('.cdp-reset');
        const doneBtn = overlay.querySelector('.cdp-done');

        pauseBtn?.addEventListener('click', (e: any) => {
          e.stopPropagation();
          const isPaused = !(globalThis as any).__cdpRecordingPaused;
          (globalThis as any).__cdpRecordingPaused = isPaused;
          pauseBtn.textContent = isPaused ? '▶' : '⏸';
          const statusEl = overlay.querySelector('.cdp-status');
          if (statusEl) {
            statusEl.textContent = isPaused ? 'PAUSED' : 'REC';
            statusEl.style.background = isPaused ? '#eab308' : '#ef4444';
          }
        });

        resetBtn?.addEventListener('click', (e: any) => {
          e.stopPropagation();
          (globalThis as any).__cdpRecordingEvents = [];
          (globalThis as any).__cdpRecordingStart = Date.now();
          const statsEl = overlay.querySelector('.cdp-stats');
          if (statsEl) statsEl.textContent = '0 | 0.0s';
        });

        doneBtn?.addEventListener('click', (e: any) => {
          e.stopPropagation();
          (globalThis as any).__cdpRecordingState = 'completed';
          const panel = overlay.querySelector('.cdp-panel');
          if (panel) {
            panel.style.background = 'rgba(5, 150, 105, 0.9)';
            panel.innerHTML = '<span style="padding: 4px 8px;">✓ Recording complete - retrieve with stopMouseRecording</span>';
          }
        });

        // Create highlight box
        highlightBox = doc.createElement('div');
        highlightBox.id = '__cdp-highlight-box';
        highlightBox.style.cssText = `
          position: fixed;
          pointer-events: none;
          border: 2px solid #6366f1;
          background: rgba(99, 102, 241, 0.05);
          z-index: 2147483646;
          display: none;
          transition: all 0.05s ease-out;
          border-radius: 2px;
        `;
        doc.body.appendChild(highlightBox);

        (globalThis as any).__cdpOverlay = overlay;
        (globalThis as any).__cdpHighlightBox = highlightBox;
      }

      // Store listener references
      (globalThis as any).__cdpRecordingListeners = {
        mousemove: (e: any) => captureMouseEvent(e, 'mousemove'),
        mousedown: (e: any) => captureMouseEvent(e, 'mousedown'),
        mouseup: (e: any) => captureMouseEvent(e, 'mouseup'),
        wheel: (e: any) => captureMouseEvent(e, 'wheel'),
        click: (e: any) => captureMouseEvent(e, 'click'),
        dblclick: (e: any) => captureMouseEvent(e, 'dblclick'),
        keydown: (e: any) => captureKeyEvent(e, 'keydown'),
        keyup: (e: any) => captureKeyEvent(e, 'keyup'),
      };

      // Add all listeners
      const listeners = (globalThis as any).__cdpRecordingListeners;
      doc.addEventListener('mousemove', listeners.mousemove, { capture: true, passive: true });
      doc.addEventListener('mousedown', listeners.mousedown, { capture: true, passive: true });
      doc.addEventListener('mouseup', listeners.mouseup, { capture: true, passive: true });
      doc.addEventListener('wheel', listeners.wheel, { capture: true, passive: true });
      doc.addEventListener('click', listeners.click, { capture: true, passive: true });
      doc.addEventListener('dblclick', listeners.dblclick, { capture: true, passive: true });
      doc.addEventListener('keydown', listeners.keydown, { capture: true, passive: true });
      doc.addEventListener('keyup', listeners.keyup, { capture: true, passive: true });
    }, showOverlay);

    // Store cleanup function
    cleanupHandles.set(connectionReference, async () => {
      try {
        await page.evaluate(() => {
          const listeners = (globalThis as any).__cdpRecordingListeners;
          const doc = (globalThis as any).document;
          if (listeners) {
            doc.removeEventListener('mousemove', listeners.mousemove, { capture: true });
            doc.removeEventListener('mousedown', listeners.mousedown, { capture: true });
            doc.removeEventListener('mouseup', listeners.mouseup, { capture: true });
            doc.removeEventListener('wheel', listeners.wheel, { capture: true });
            doc.removeEventListener('click', listeners.click, { capture: true });
            doc.removeEventListener('dblclick', listeners.dblclick, { capture: true });
            doc.removeEventListener('keydown', listeners.keydown, { capture: true });
            doc.removeEventListener('keyup', listeners.keyup, { capture: true });
          }
          // Remove overlay elements
          const overlay = doc.getElementById('__cdp-recording-overlay');
          const highlight = doc.getElementById('__cdp-highlight-box');
          if (overlay) overlay.remove();
          if (highlight) highlight.remove();

          delete (globalThis as any).__cdpRecordingEvents;
          delete (globalThis as any).__cdpRecordingListeners;
          delete (globalThis as any).__cdpRecordingStart;
          delete (globalThis as any).__cdpRecordingPaused;
          delete (globalThis as any).__cdpRecordingState;
          delete (globalThis as any).__cdpOverlay;
          delete (globalThis as any).__cdpHighlightBox;
        });
      } catch (e) {
        // Page may have navigated, ignore cleanup errors
      }
    });

    return { success: true };
  } catch (error: any) {
    activeSessions.delete(connectionReference);
    return { success: false, error: error.message || String(error) };
  }
}

/**
 * Stop recording and return captured events
 */
export async function stopMouseRecording(
  page: Page,
  connectionReference: string
): Promise<{ success: boolean; events?: InputEvent[]; duration?: number; error?: string }> {
  const session = activeSessions.get(connectionReference);
  if (!session) {
    return { success: false, error: 'No active recording for this connection' };
  }

  try {
    // Retrieve captured events from the page
    const events = await page.evaluate(() => {
      return (globalThis as any).__cdpRecordingEvents || [];
    }) as InputEvent[];

    // Run cleanup
    const cleanup = cleanupHandles.get(connectionReference);
    if (cleanup) {
      await cleanup();
      cleanupHandles.delete(connectionReference);
    }

    const duration = Date.now() - session.startTime;
    activeSessions.delete(connectionReference);

    return {
      success: true,
      events,
      duration,
    };
  } catch (error: any) {
    activeSessions.delete(connectionReference);
    cleanupHandles.delete(connectionReference);
    return { success: false, error: error.message || String(error) };
  }
}

/**
 * Check if recording is active for a connection
 */
export function isRecording(connectionReference: string): boolean {
  return activeSessions.has(connectionReference);
}

/**
 * Get current event count without stopping recording
 */
export async function getRecordingStatus(
  page: Page,
  connectionReference: string
): Promise<{ isRecording: boolean; eventCount?: number; duration?: number; isPaused?: boolean; state?: string }> {
  const session = activeSessions.get(connectionReference);
  if (!session) {
    return { isRecording: false };
  }

  try {
    const status = await page.evaluate(() => {
      return {
        count: (globalThis as any).__cdpRecordingEvents?.length || 0,
        isPaused: (globalThis as any).__cdpRecordingPaused || false,
        state: (globalThis as any).__cdpRecordingState || 'recording',
      };
    });

    return {
      isRecording: true,
      eventCount: status.count,
      isPaused: status.isPaused,
      state: status.state,
      duration: Date.now() - session.startTime,
    };
  } catch {
    return { isRecording: true, duration: Date.now() - session.startTime };
  }
}

// Type guard for mouse events
function isMouseEvent(event: InputEvent): event is MouseEvent {
  return 'x' in event && 'y' in event;
}

// Type guard for keyboard events
function isKeyboardEvent(event: InputEvent): event is KeyboardEvent {
  return 'key' in event && 'code' in event;
}

/**
 * Simplify recorded events by removing redundant mousemove events
 * Keeps only significant movements (distance threshold or time gap)
 * Also collapses consecutive keydown events into typing sequences
 */
export function simplifyMouseEvents(
  events: InputEvent[],
  options: { distanceThreshold?: number; timeThreshold?: number } = {}
): InputEvent[] {
  const { distanceThreshold = 10, timeThreshold = 100 } = options;

  const simplified: InputEvent[] = [];
  let lastMove: MouseEvent | null = null;

  for (const event of events) {
    // Handle keyboard events - always keep them
    if (isKeyboardEvent(event)) {
      if (lastMove) {
        simplified.push(lastMove);
        lastMove = null;
      }
      simplified.push(event);
      continue;
    }

    // Handle mouse events
    if (isMouseEvent(event)) {
      if (event.type !== 'mousemove') {
        // Always keep non-move events
        if (lastMove) {
          simplified.push(lastMove);
          lastMove = null;
        }
        simplified.push(event);
      } else {
        if (!lastMove) {
          lastMove = event;
        } else {
          const distance = Math.sqrt(
            Math.pow(event.x - lastMove.x, 2) + Math.pow(event.y - lastMove.y, 2)
          );
          const timeDiff = event.timestamp - lastMove.timestamp;

          if (distance >= distanceThreshold || timeDiff >= timeThreshold) {
            simplified.push(lastMove);
            lastMove = event;
          } else {
            // Update lastMove to keep the most recent position
            lastMove = event;
          }
        }
      }
    }
  }

  // Don't forget the last move
  if (lastMove) {
    simplified.push(lastMove);
  }

  return simplified;
}

export interface CommandConversionOptions {
  simplify?: boolean;
  includeHovers?: boolean;
  preferCoordinates?: boolean;  // Use coordinates instead of selectors (for canvas/3D)
  preferSelectors?: boolean;    // Use selectors when available (for DOM testing)
}

/**
 * Convert recorded events to cdp-tools sequence commands
 */
export function eventsToSequenceCommands(
  events: InputEvent[],
  options: CommandConversionOptions = {}
): Array<{ tool: string; params: Record<string, any> }> {
  const { simplify = true, includeHovers = false, preferCoordinates = false, preferSelectors = false } = options;

  const processedEvents = simplify ? simplifyMouseEvents(events) : events;
  const commands: Array<{ tool: string; params: Record<string, any> }> = [];

  let i = 0;
  while (i < processedEvents.length) {
    const event = processedEvents[i];

    // Handle keyboard events
    if (isKeyboardEvent(event)) {
      // Only handle keydown, skip keyup
      if (event.type === 'keydown') {
        // Check if this is part of a typing sequence (consecutive printable chars)
        if (event.key.length === 1 && !event.modifiers?.ctrl && !event.modifiers?.alt && !event.modifiers?.meta) {
          // Collect consecutive typing
          let typedText = event.key;
          let j = i + 1;
          while (j < processedEvents.length) {
            const next = processedEvents[j];
            if (isKeyboardEvent(next) && next.type === 'keydown' &&
                next.key.length === 1 && !next.modifiers?.ctrl && !next.modifiers?.alt && !next.modifiers?.meta) {
              typedText += next.key;
              j++;
            } else if (isKeyboardEvent(next) && next.type === 'keyup') {
              // Skip keyup events in typing sequence
              j++;
            } else {
              break;
            }
          }
          if (typedText.length > 1) {
            commands.push({
              tool: 'input',
              params: { action: 'type', text: typedText },
            });
            i = j;
            continue;
          }
        }
        // Single key press (special keys or modified keys)
        const key = event.key;
        const modifiers = event.modifiers;
        let keyCombo = key;
        if (modifiers) {
          const parts: string[] = [];
          if (modifiers.ctrl) parts.push('Control');
          if (modifiers.alt) parts.push('Alt');
          if (modifiers.shift && key.length > 1) parts.push('Shift'); // Only add Shift for non-chars
          if (modifiers.meta) parts.push('Meta');
          if (parts.length > 0) {
            keyCombo = parts.join('+') + '+' + key;
          }
        }
        commands.push({
          tool: 'input',
          params: { action: 'press', key: keyCombo },
        });
      }
      i++;
      continue;
    }

    // Handle mouse events (existing code)
    if (!isMouseEvent(event)) {
      i++;
      continue;
    }

    // Look for drag sequences (mousedown -> mousemove+ -> mouseup)
    if (event.type === 'mousedown') {
      const dragStart = { x: event.x, y: event.y };
      let dragEnd = dragStart;
      let j = i + 1;

      // Find the mouseup
      while (j < processedEvents.length && processedEvents[j].type !== 'mouseup') {
        const nextEvent = processedEvents[j];
        if (isMouseEvent(nextEvent) && nextEvent.type === 'mousemove') {
          dragEnd = { x: nextEvent.x, y: nextEvent.y };
        }
        j++;
      }

      if (j < processedEvents.length && processedEvents[j].type === 'mouseup') {
        const mouseup = processedEvents[j];
        if (isMouseEvent(mouseup)) {
          dragEnd = { x: mouseup.x, y: mouseup.y };
        }

        // Check if this was a drag (significant movement) or a click
        const distance = Math.sqrt(
          Math.pow(dragEnd.x - dragStart.x, 2) + Math.pow(dragEnd.y - dragStart.y, 2)
        );

        if (distance > 5) {
          // This is a drag - always use coordinates
          commands.push({
            tool: 'input',
            params: {
              action: 'drag',
              from: dragStart,
              to: dragEnd,
            },
          });
        }
        // Skip to after mouseup
        i = j + 1;
        continue;
      }
    }

    // Handle wheel events - always use coordinates
    if (event.type === 'wheel' && (event.deltaX || event.deltaY)) {
      commands.push({
        tool: 'input',
        params: {
          action: 'scroll',
          x: event.x,
          y: event.y,
          deltaX: event.deltaX || 0,
          deltaY: event.deltaY || 0,
        },
      });
      i++;
      continue;
    }

    // Handle clicks
    if (event.type === 'click') {
      const elementInfo = event.elementInfo;
      const selector = elementInfo?.selector;
      const isCanvas = elementInfo?.isCanvas;

      // Use selector when available, unless preferCoordinates is set or element is canvas
      // Selector-based clicks are more reliable as they survive layout changes
      const useSelector = selector && !preferCoordinates && !isCanvas;

      if (useSelector) {
        commands.push({
          tool: 'input',
          params: {
            action: 'click',
            selector,
          },
        });
      } else {
        // Use coordinate-based approach for canvas/3D or when no selector available
        commands.push({
          tool: 'input',
          params: {
            action: 'mousemove',
            x: event.x,
            y: event.y,
          },
        });
        // For coordinate clicks, use page.mouse.click in puppeteer
        // In cdp-tools, we need to click after moving
        commands.push({
          tool: 'input',
          params: {
            action: 'click',
            selector: 'body', // Click wherever mouse is
            _coordinateClick: true, // Marker for puppeteer conversion
            _x: event.x,
            _y: event.y,
          },
        });
      }
      i++;
      continue;
    }

    // Handle mousemove (for hover effects if requested)
    if (event.type === 'mousemove' && includeHovers) {
      commands.push({
        tool: 'input',
        params: {
          action: 'mousemove',
          x: event.x,
          y: event.y,
        },
      });
    }

    i++;
  }

  return commands;
}

/**
 * Format events for human review - shows both coordinate and selector options
 */
export function formatEventsForReview(events: InputEvent[]): string {
  const lines: string[] = [];
  let eventNum = 0;

  for (const event of events) {
    // Handle keyboard events
    if (isKeyboardEvent(event)) {
      // Skip keyup for review
      if (event.type === 'keyup') continue;

      eventNum++;
      const time = new Date(event.timestamp).toISOString().split('T')[1].split('.')[0];

      let keyDisplay = event.key;
      if (event.modifiers) {
        const mods: string[] = [];
        if (event.modifiers.ctrl) mods.push('Ctrl');
        if (event.modifiers.alt) mods.push('Alt');
        if (event.modifiers.shift) mods.push('Shift');
        if (event.modifiers.meta) mods.push('Cmd');
        if (mods.length > 0) keyDisplay = mods.join('+') + '+' + keyDisplay;
      }

      lines.push(`### ${eventNum}. KEY \`${keyDisplay}\``);
      lines.push(`Time: ${time}`);
      if (event.targetInfo) {
        lines.push(`Target: \`${event.targetInfo.tag}${event.targetInfo.id ? '#' + event.targetInfo.id : ''}\``);
        if (event.targetInfo.isInput) {
          lines.push(`Type: **Input field**`);
        }
      }
      lines.push('');
      continue;
    }

    // Handle mouse events
    if (!isMouseEvent(event)) continue;

    // Skip pure mousemove events for review (too noisy)
    if (event.type === 'mousemove') continue;

    eventNum++;
    const time = new Date(event.timestamp).toISOString().split('T')[1].split('.')[0];
    const coords = `(${event.x}, ${event.y})`;
    const el = event.elementInfo;

    lines.push(`### ${eventNum}. ${event.type.toUpperCase()} at ${coords}`);
    lines.push(`Time: ${time}`);

    if (el) {
      lines.push(`Element: \`${el.tag}${el.id ? '#' + el.id : ''}${el.className ? '.' + el.className.split(' ')[0] : ''}\``);

      if (el.selector) {
        lines.push(`Selector: \`${el.selector}\` ✓`);
      } else {
        lines.push(`Selector: *(none available)*`);
      }

      if (el.isCanvas) {
        lines.push(`Type: **Canvas/3D** - use coordinates`);
      } else if (el.isInteractive) {
        lines.push(`Type: **Interactive** - selector recommended`);
      }

      if (el.text) {
        lines.push(`Text: "${el.text.substring(0, 40)}${el.text.length > 40 ? '...' : ''}"`);
      }

      if (el.boundingBox) {
        const bb = el.boundingBox;
        lines.push(`Bounds: ${bb.width}x${bb.height} at (${bb.x}, ${bb.y})`);
      }
    }

    // Add specific event data
    if (event.type === 'wheel') {
      lines.push(`Scroll: deltaX=${event.deltaX || 0}, deltaY=${event.deltaY || 0}`);
    }

    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Analyze events and provide summary statistics
 */
export function analyzeEvents(events: InputEvent[]): {
  totalEvents: number;
  clicks: number;
  drags: number;
  scrolls: number;
  keyPresses: number;
  typedCharacters: number;
  canvasInteractions: number;
  interactiveElements: number;
  selectorsAvailable: number;
  coordinatesOnly: number;
} {
  let clicks = 0;
  let drags = 0;
  let scrolls = 0;
  let keyPresses = 0;
  let typedCharacters = 0;
  let canvasInteractions = 0;
  let interactiveElements = 0;
  let selectorsAvailable = 0;
  let coordinatesOnly = 0;

  // Detect drags
  let inDrag = false;
  let dragStartIdx = -1;
  let lastMouseEvent: MouseEvent | null = null;

  for (let i = 0; i < events.length; i++) {
    const event = events[i];

    // Handle keyboard events
    if (isKeyboardEvent(event)) {
      if (event.type === 'keydown') {
        keyPresses++;
        if (event.key.length === 1) {
          typedCharacters++;
        }
      }
      continue;
    }

    // Handle mouse events
    if (!isMouseEvent(event)) continue;

    if (event.type === 'mousedown') {
      inDrag = true;
      dragStartIdx = i;
      lastMouseEvent = event;
    } else if (event.type === 'mouseup' && inDrag && lastMouseEvent) {
      // Check if it was a drag or click
      const distance = Math.sqrt(
        Math.pow(event.x - lastMouseEvent.x, 2) + Math.pow(event.y - lastMouseEvent.y, 2)
      );
      if (distance > 5) {
        drags++;
      }
      inDrag = false;
    } else if (event.type === 'click') {
      clicks++;
      if (event.elementInfo?.isCanvas) {
        canvasInteractions++;
        coordinatesOnly++;
      } else if (event.elementInfo?.selector) {
        selectorsAvailable++;
        if (event.elementInfo?.isInteractive) {
          interactiveElements++;
        }
      } else {
        coordinatesOnly++;
      }
    } else if (event.type === 'wheel') {
      scrolls++;
    }
  }

  return {
    totalEvents: events.length,
    clicks,
    drags,
    scrolls,
    keyPresses,
    typedCharacters,
    canvasInteractions,
    interactiveElements,
    selectorsAvailable,
    coordinatesOnly,
  };
}
