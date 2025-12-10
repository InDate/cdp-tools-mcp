/**
 * Interaction Recorder
 *
 * Records user interactions (mouse, keyboard, navigation) from a browser page
 * for later replay or conversion to test scripts.
 *
 * Actions:
 * - recordInteraction: Start recording
 * - stopInteraction: Stop recording, keep in memory
 * - replayInteraction: Get recorded events by index
 * - clearInteraction: Clear recording from memory
 */

import type { Page } from 'puppeteer-core';

// =============================================================================
// Types
// =============================================================================

export interface ElementInfo {
  tag: string;
  id?: string;
  className?: string;
  text?: string;
  selector?: string;
  isCanvas?: boolean;
  isInteractive?: boolean;
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
  button?: number;
  buttons?: number;
  deltaX?: number;
  deltaY?: number;
  clickCount?: number;
  elementInfo?: ElementInfo;
}

export interface KeyboardEvent {
  type: 'keydown' | 'keyup';
  key: string;
  code: string;
  timestamp: number;
  modifiers?: {
    ctrl?: boolean;
    alt?: boolean;
    shift?: boolean;
    meta?: boolean;
  };
  repeat?: boolean;
  targetInfo?: {
    tag: string;
    id?: string;
    isInput?: boolean;
  };
}

export interface NavigationEvent {
  type: 'navigation' | 'reload';
  url: string;
  timestamp: number;
  previousUrl?: string;
}

export type CommentCategory = 'narrative' | 'bug' | 'feature';

export interface CommentEvent {
  type: 'comment';
  text: string;
  timestamp: number;
  category: CommentCategory;
  attachedToEventIndex?: number; // Index of the event this comment is attached to
}

export type InputEvent = MouseEvent | KeyboardEvent | NavigationEvent | CommentEvent;

export interface RecordingOptions {
  showOverlay?: boolean;
}

export interface RecordingSession {
  id: number;
  connectionReference: string;
  startTime: number;
  endTime?: number;
  startUrl: string;
  events: InputEvent[];
  isRecording: boolean;
  isPaused: boolean;
}

export interface StoredRecording {
  id: number;
  connectionReference: string;
  startTime: number;
  endTime: number;
  startUrl: string;
  duration: number;
  events: InputEvent[];
  summary: {
    clicks: number;
    drags: number;
    scrolls: number;
    keyPresses: number;
    navigations: number;
    comments: number;
  };
}

// =============================================================================
// State
// =============================================================================

// Active recording session (one per connection)
const activeSessions = new Map<string, RecordingSession>();

// Completed recordings stored by index
const storedRecordings = new Map<number, StoredRecording>();
let nextRecordingId = 1;

// Cleanup handles for page listeners
const cleanupHandles = new Map<string, () => Promise<void>>();

// =============================================================================
// Type Guards
// =============================================================================

export function isMouseEvent(event: InputEvent): event is MouseEvent {
  return 'x' in event && 'y' in event;
}

export function isKeyboardEvent(event: InputEvent): event is KeyboardEvent {
  return 'key' in event && 'code' in event;
}

export function isNavigationEvent(event: InputEvent): event is NavigationEvent {
  return event.type === 'navigation' || event.type === 'reload';
}

export function isCommentEvent(event: InputEvent): event is CommentEvent {
  return event.type === 'comment';
}

// =============================================================================
// Recording Functions
// =============================================================================

/**
 * Start recording interactions on a page.
 * Returns a promise that resolves when the recording is completed (via UI or stopRecording).
 */
export async function startRecording(
  page: Page,
  connectionReference: string,
  options: RecordingOptions = {}
): Promise<{ success: boolean; id?: number; recording?: StoredRecording; error?: string }> {
  if (activeSessions.has(connectionReference)) {
    return { success: false, error: 'Recording already active for this connection' };
  }

  const id = nextRecordingId++;
  const startUrl = page.url();

  const session: RecordingSession = {
    id,
    connectionReference,
    startTime: Date.now(),
    startUrl,
    events: [],
    isRecording: true,
    isPaused: false,
  };

  activeSessions.set(connectionReference, session);

  const showOverlay = options.showOverlay ?? true;

  // Create a promise that will resolve when recording completes
  let resolveRecording: (result: { success: boolean; id?: number; recording?: StoredRecording; error?: string }) => void;
  const recordingPromise = new Promise<{ success: boolean; id?: number; recording?: StoredRecording; error?: string }>((resolve) => {
    resolveRecording = resolve;
  });

  try {
    // Set up navigation tracking via CDP
    const client = await page.createCDPSession();
    let currentUrl = startUrl;

    // Listen for navigation events
    client.on('Page.frameNavigated', (params: any) => {
      if (params.frame.parentId) return; // Only main frame
      const newUrl = params.frame.url;
      if (newUrl !== currentUrl) {
        const navEvent: NavigationEvent = {
          type: 'navigation',
          url: newUrl,
          previousUrl: currentUrl,
          timestamp: Date.now(),
        };
        session.events.push(navEvent);
        currentUrl = newUrl;
      }
    });

    await client.send('Page.enable');

    // Set up binding for UI stop button to call back to server
    await client.send('Runtime.addBinding', { name: '__cdpRecordingComplete' });

    client.on('Runtime.bindingCalled', async (event: any) => {
      if (event.name === '__cdpRecordingComplete') {
        // UI stop button was clicked - process the recording
        try {
          const payload = JSON.parse(event.payload);
          const browserEvents = payload.events as InputEvent[];
          const pausePeriods = payload.pausePeriods || [] as { start: number; end: number }[];

          // Adjust event timestamps to exclude time spent in comment modals
          // For each event, subtract the total pause time that occurred before it
          const adjustedBrowserEvents = browserEvents.map(e => {
            let adjustment = 0;
            for (const pause of pausePeriods) {
              if (e.timestamp > pause.end) {
                // Event occurred after this pause ended - subtract full pause duration
                adjustment += pause.end - pause.start;
              } else if (e.timestamp > pause.start) {
                // Event occurred during pause (shouldn't happen normally, but handle it)
                adjustment += e.timestamp - pause.start;
              }
              // If event occurred before pause started, no adjustment needed
            }
            return adjustment > 0 ? { ...e, timestamp: e.timestamp - adjustment } : e;
          });

          // Merge browser events with navigation events from session
          const allEvents = [...session.events, ...adjustedBrowserEvents].sort((a, b) => a.timestamp - b.timestamp);

          const endTime = Date.now();
          const duration = endTime - session.startTime;

          // Calculate summary
          const summary = calculateSummary(allEvents);

          // Store the recording
          const stored: StoredRecording = {
            id: session.id,
            connectionReference,
            startTime: session.startTime,
            endTime,
            startUrl: session.startUrl,
            duration,
            events: allEvents,
            summary,
          };

          storedRecordings.set(session.id, stored);

          // Cleanup
          cleanupHandles.delete(connectionReference);
          activeSessions.delete(connectionReference);

          // Resolve the blocking promise
          resolveRecording({ success: true, id: session.id, recording: stored });
        } catch (e) {
          console.error('[cdp-tools] Error processing UI stop:', e);
          resolveRecording({ success: false, error: String(e) });
        }
      }
    });

    // Inject event listeners into the page
    await page.evaluate((showOverlayParam: boolean) => {
      (globalThis as any).__cdpRecordingEvents = [];
      (globalThis as any).__cdpRecordingStart = Date.now();
      (globalThis as any).__cdpRecordingPaused = false;
      (globalThis as any).__cdpRecordingState = 'recording';
      (globalThis as any).__cdpPausePeriods = [];  // Clear pause periods from previous recording

      const doc = (globalThis as any).document;

      // Build selector helper
      const buildSelector = (el: any): string | undefined => {
        if (!el || el === doc.body || el === doc.documentElement) return undefined;
        if (el.id) return `#${el.id}`;
        if (el.className && typeof el.className === 'string') {
          const classes = el.className.trim().split(/\s+/).filter((c: string) => c.length > 0);
          if (classes.length > 0) {
            const selector = `${el.tagName.toLowerCase()}.${classes.slice(0, 2).join('.')}`;
            try {
              if (doc.querySelectorAll(selector).length === 1) return selector;
            } catch (e) { /* invalid selector */ }
          }
        }
        const dataAttrs = ['data-testid', 'data-id', 'data-name', 'name', 'aria-label'];
        for (const attr of dataAttrs) {
          const val = el.getAttribute?.(attr);
          if (val) {
            const selector = `${el.tagName.toLowerCase()}[${attr}="${val}"]`;
            try {
              if (doc.querySelectorAll(selector).length === 1) return selector;
            } catch (e) { /* invalid selector */ }
          }
        }
        return el.tagName?.toLowerCase();
      };

      // Get element info helper
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

      // Check if element is part of our overlay UI
      const isOurUI = (el: any): boolean => {
        if (!el) return false;
        // Check if element or any parent is our overlay
        let current = el;
        while (current) {
          if (current.id === '__cdp-recording-overlay') return true;
          if (current.classList?.contains('cdp-panel')) return true;
          if (current.classList?.contains('cdp-btn')) return true;
          if (current.classList?.contains('cdp-comment-modal')) return true;
          current = current.parentElement;
        }
        return false;
      };

      // Capture mouse event
      const captureMouseEvent = (e: any, type: string) => {
        if ((globalThis as any).__cdpRecordingPaused) return;
        if ((globalThis as any).__cdpCommentModalOpen) return;
        if (isOurUI(e.target)) return;
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
        if ((globalThis as any).__cdpCommentModalOpen) return;
        // Skip modifier-only keys (they'll be captured with the actual key press)
        if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
        // Skip the comment shortcut (Ctrl/Cmd + Shift + C)
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'c') return;
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

      // Overlay
      let overlay: any = null;

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
          const isComment = type === 'comment';
          eventEl.textContent = isComment ? 'NOTE' : isKey ? event.key : type.replace('mouse', '').toUpperCase();
          eventEl.style.background = isComment ? '#f59e0b' :
                                     type === 'click' ? '#ef4444' :
                                     type === 'wheel' ? '#3b82f6' :
                                     isKey ? '#10b981' :
                                     type.includes('mouse') ? '#8b5cf6' : '#6b7280';
        }
      };

      if (showOverlayParam) {
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
            <span class="cdp-status" style="padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; background: #ef4444; letter-spacing: 0.5px;">REC</span>
            <span class="cdp-stats" style="color: #d1d5db; min-width: 60px;">0 | 0.0s</span>
            <span class="cdp-event" style="padding: 2px 8px; border-radius: 4px; font-size: 10px; background: #6b7280; min-width: 50px; text-align: center;">-</span>
            <div style="display: flex; gap: 4px; margin-left: 6px;">
              <button class="cdp-btn cdp-comment" title="Add Comment (Cmd+Shift+C) | Bug (Cmd+Shift+B) | Feature (Cmd+Shift+F)" style="background: #374151; border: none; color: white; width: 24px; height: 24px; border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 10px;">💬</button>
              <button class="cdp-btn cdp-pause" title="Pause/Resume" style="background: #374151; border: none; color: white; width: 24px; height: 24px; border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 10px;">⏸</button>
              <button class="cdp-btn cdp-reset" title="Reset" style="background: #374151; border: none; color: white; width: 24px; height: 24px; border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 10px;">↺</button>
              <button class="cdp-btn cdp-done" title="Complete" style="background: #059669; border: none; color: white; width: 24px; height: 24px; border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 10px;">✓</button>
            </div>
          </div>
          <div class="cdp-comment-modal" style="
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.8);
            z-index: 2147483648;
            justify-content: center;
            align-items: center;
            font-family: -apple-system, system-ui, sans-serif;
          ">
            <div style="
              background: #1f2937;
              border-radius: 12px;
              padding: 24px;
              width: 90%;
              max-width: 500px;
              box-shadow: 0 25px 50px rgba(0,0,0,0.5);
            ">
              <h3 style="margin: 0 0 16px 0; color: white; font-size: 18px;">Add Comment</h3>
              <div class="cdp-comment-category" style="display: flex; gap: 0; margin-bottom: 16px;">
                <label style="flex: 1; cursor: pointer;">
                  <input type="radio" name="cdp-category" value="narrative" checked style="display: none;">
                  <span class="cdp-cat-btn" data-cat="narrative" style="
                    display: block;
                    text-align: center;
                    padding: 8px 12px;
                    background: #3b82f6;
                    color: white;
                    font-size: 13px;
                    font-weight: 500;
                    border-radius: 6px 0 0 6px;
                    border: 1px solid #3b82f6;
                  ">NARRATIVE</span>
                </label>
                <label style="flex: 1; cursor: pointer;">
                  <input type="radio" name="cdp-category" value="bug" style="display: none;">
                  <span class="cdp-cat-btn" data-cat="bug" style="
                    display: block;
                    text-align: center;
                    padding: 8px 12px;
                    background: #374151;
                    color: #9ca3af;
                    font-size: 13px;
                    font-weight: 500;
                    border-top: 1px solid #4b5563;
                    border-bottom: 1px solid #4b5563;
                  ">BUG</span>
                </label>
                <label style="flex: 1; cursor: pointer;">
                  <input type="radio" name="cdp-category" value="feature" style="display: none;">
                  <span class="cdp-cat-btn" data-cat="feature" style="
                    display: block;
                    text-align: center;
                    padding: 8px 12px;
                    background: #374151;
                    color: #9ca3af;
                    font-size: 13px;
                    font-weight: 500;
                    border-radius: 0 6px 6px 0;
                    border: 1px solid #4b5563;
                  ">FEATURE</span>
                </label>
              </div>
              <textarea class="cdp-comment-input" style="
                width: 100%;
                height: 120px;
                background: #374151;
                border: 1px solid #4b5563;
                border-radius: 8px;
                color: white;
                padding: 12px;
                font-size: 14px;
                resize: vertical;
                box-sizing: border-box;
              " placeholder="e.g., 'Expected the form to show a success message'"></textarea>
              <div style="display: flex; gap: 12px; margin-top: 16px; justify-content: flex-end;">
                <button class="cdp-comment-cancel" style="
                  background: #374151;
                  border: none;
                  color: white;
                  padding: 8px 16px;
                  border-radius: 6px;
                  cursor: pointer;
                  font-size: 14px;
                ">Cancel</button>
                <button class="cdp-comment-save" style="
                  background: #3b82f6;
                  border: none;
                  color: white;
                  padding: 8px 16px;
                  border-radius: 6px;
                  cursor: pointer;
                  font-size: 14px;
                ">Save Comment</button>
              </div>
            </div>
          </div>
        `;
        doc.body.appendChild(overlay);

        const pauseBtn = overlay.querySelector('.cdp-pause');
        const resetBtn = overlay.querySelector('.cdp-reset');
        const doneBtn = overlay.querySelector('.cdp-done');
        const commentBtn = overlay.querySelector('.cdp-comment');
        const commentModal = overlay.querySelector('.cdp-comment-modal');
        const commentInput = overlay.querySelector('.cdp-comment-input') as any;
        const commentCancel = overlay.querySelector('.cdp-comment-cancel');
        const commentSave = overlay.querySelector('.cdp-comment-save');
        const categoryBtns = overlay.querySelectorAll('.cdp-cat-btn');
        const categoryRadios = overlay.querySelectorAll('input[name="cdp-category"]') as any;

        // Category button styling
        const updateCategoryStyles = () => {
          categoryBtns.forEach((btn: any) => {
            const cat = btn.dataset.cat;
            const radio = overlay.querySelector(`input[value="${cat}"]`) as any;
            if (radio?.checked) {
              btn.style.background = cat === 'bug' ? '#dc2626' : cat === 'feature' ? '#059669' : '#3b82f6';
              btn.style.color = 'white';
              btn.style.borderColor = btn.style.background;
            } else {
              btn.style.background = '#374151';
              btn.style.color = '#9ca3af';
              btn.style.borderColor = '#4b5563';
            }
          });
        };

        categoryRadios.forEach((radio: any) => {
          radio.addEventListener('change', updateCategoryStyles);
        });

        // Comment modal functions
        const showCommentModal = (category: string = 'narrative') => {
          if (commentModal) {
            (globalThis as any).__cdpCommentModalOpen = true;
            (globalThis as any).__cdpCommentModalOpenedAt = Date.now();
            commentModal.style.display = 'flex';
            // Set the specified category
            const radio = overlay.querySelector(`input[value="${category}"]`) as any;
            if (radio) radio.checked = true;
            updateCategoryStyles();
            if (commentInput) {
              commentInput.value = '';
              commentInput.focus();
            }
          }
        };

        const hideCommentModal = () => {
          if (commentModal) {
            // Track pause periods to adjust event timestamps later
            const openedAt = (globalThis as any).__cdpCommentModalOpenedAt;
            if (openedAt) {
              const closedAt = Date.now();
              const pausePeriods = (globalThis as any).__cdpPausePeriods || [];
              pausePeriods.push({ start: openedAt, end: closedAt });
              (globalThis as any).__cdpPausePeriods = pausePeriods;
              delete (globalThis as any).__cdpCommentModalOpenedAt;
            }
            (globalThis as any).__cdpCommentModalOpen = false;
            commentModal.style.display = 'none';
          }
        };

        const saveComment = () => {
          const text = commentInput?.value?.trim();
          if (text) {
            const events = (globalThis as any).__cdpRecordingEvents;
            // Use the timestamp when modal was opened, not current time
            // This way the comment appears at the right point in the timeline
            const modalOpenedAt = (globalThis as any).__cdpCommentModalOpenedAt || Date.now();
            // Get selected category
            const selectedRadio = overlay.querySelector('input[name="cdp-category"]:checked') as any;
            const category = selectedRadio?.value || 'narrative';
            const commentEvent = {
              type: 'comment',
              text,
              timestamp: modalOpenedAt,
              category,
              attachedToEventIndex: events.length > 0 ? events.length - 1 : undefined,
            };
            events.push(commentEvent);
            updateOverlay(commentEvent, 'comment');
          }
          hideCommentModal();
        };

        commentBtn?.addEventListener('click', (e: any) => {
          e.stopPropagation();
          showCommentModal();
        });

        commentCancel?.addEventListener('click', (e: any) => {
          e.stopPropagation();
          hideCommentModal();
        });

        commentSave?.addEventListener('click', (e: any) => {
          e.stopPropagation();
          saveComment();
        });

        // Handle all keyboard events in comment input - stop them from reaching the app
        commentInput?.addEventListener('keydown', (e: any) => {
          e.stopPropagation();
          if (e.key === 'Escape') {
            e.preventDefault();
            hideCommentModal();
          } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            saveComment();
          }
        });
        commentInput?.addEventListener('keyup', (e: any) => {
          e.stopPropagation();
        });
        commentInput?.addEventListener('keypress', (e: any) => {
          e.stopPropagation();
        });

        // Global keyboard shortcuts for comments (Ctrl/Cmd + Shift + C/B/F)
        const commentShortcutHandler = (e: any) => {
          if ((globalThis as any).__cdpRecordingState === 'completed') return;
          if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;

          const key = e.key.toLowerCase();
          let category: string | null = null;

          if (key === 'c') category = 'narrative';
          else if (key === 'b') category = 'bug';
          else if (key === 'f') category = 'feature';

          if (category) {
            e.preventDefault();
            e.stopPropagation();
            showCommentModal(category);
          }
        };
        doc.addEventListener('keydown', commentShortcutHandler, { capture: true });
        (globalThis as any).__cdpCommentShortcutHandler = commentShortcutHandler;

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

          // Send events to server via CDP binding
          const events = (globalThis as any).__cdpRecordingEvents || [];
          const pausePeriods = (globalThis as any).__cdpPausePeriods || [];
          try {
            (globalThis as any).__cdpRecordingComplete(JSON.stringify({ events, pausePeriods }));
          } catch (err) {
            console.error('[cdp-tools] Failed to send recording to server:', err);
          }

          const panel = overlay.querySelector('.cdp-panel');
          if (panel) {
            panel.style.background = 'rgba(5, 150, 105, 0.9)';
            panel.innerHTML = '<span style="padding: 4px 8px;">Saved</span>';
            // Remove overlay after brief delay
            setTimeout(() => {
              overlay.remove();
            }, 800);
          }
        });

        (globalThis as any).__cdpOverlay = overlay;
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
        await client.detach();
      } catch (e) { /* ignore */ }
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
          const overlay = doc.getElementById('__cdp-recording-overlay');
          if (overlay) overlay.remove();
          delete (globalThis as any).__cdpRecordingEvents;
          delete (globalThis as any).__cdpRecordingListeners;
          delete (globalThis as any).__cdpRecordingStart;
          delete (globalThis as any).__cdpRecordingPaused;
          delete (globalThis as any).__cdpRecordingState;
          delete (globalThis as any).__cdpOverlay;
        });
      } catch (e) { /* page may have navigated */ }
    });

    // Block until recording completes (via UI button or stopRecording call)
    return recordingPromise;
  } catch (error: any) {
    activeSessions.delete(connectionReference);
    return { success: false, error: error.message || String(error) };
  }
}

/**
 * Stop recording and store in memory
 */
export async function stopRecording(
  page: Page,
  connectionReference: string
): Promise<{ success: boolean; id?: number; recording?: StoredRecording; error?: string; alreadyStopped?: boolean }> {
  const session = activeSessions.get(connectionReference);

  // Check if recording was already stopped via UI but not yet processed
  if (!session) {
    // Check if there's a most recent stored recording for this connection
    // (user may have stopped via UI button)
    const recordings = Array.from(storedRecordings.values())
      .filter(r => r.connectionReference === connectionReference)
      .sort((a, b) => b.endTime - a.endTime);

    if (recordings.length > 0) {
      const mostRecent = recordings[0];
      // If it was stored within last 60 seconds, assume it was just stopped via UI
      if (Date.now() - mostRecent.endTime < 60000) {
        return {
          success: true,
          id: mostRecent.id,
          recording: mostRecent,
          alreadyStopped: true
        };
      }
    }

    return { success: false, error: 'No active recording for this connection' };
  }

  try {
    // Check if recording was completed via UI (but session not yet cleaned up)
    const pageState = await page.evaluate(() => {
      return {
        events: (globalThis as any).__cdpRecordingEvents || [],
        state: (globalThis as any).__cdpRecordingState,
        pausePeriods: (globalThis as any).__cdpPausePeriods || [],
      };
    });

    const pageEvents = pageState.events as InputEvent[];
    const wasCompletedViaUI = pageState.state === 'completed';
    const pausePeriods = pageState.pausePeriods as { start: number; end: number }[];

    // Adjust event timestamps to exclude time spent in comment modals
    const adjustedPageEvents = pageEvents.map(e => {
      let adjustment = 0;
      for (const pause of pausePeriods) {
        if (e.timestamp > pause.end) {
          adjustment += pause.end - pause.start;
        } else if (e.timestamp > pause.start) {
          adjustment += e.timestamp - pause.start;
        }
      }
      return adjustment > 0 ? { ...e, timestamp: e.timestamp - adjustment } : e;
    });

    // Merge page events with navigation events from session
    const allEvents = [...session.events, ...adjustedPageEvents].sort((a, b) => a.timestamp - b.timestamp);

    const endTime = Date.now();
    const duration = endTime - session.startTime;

    // Calculate summary
    const summary = calculateSummary(allEvents);

    // Store the recording
    const stored: StoredRecording = {
      id: session.id,
      connectionReference,
      startTime: session.startTime,
      endTime,
      startUrl: session.startUrl,
      duration,
      events: allEvents,
      summary,
    };

    storedRecordings.set(session.id, stored);

    // Cleanup page listeners (skip if already cleaned up via UI)
    if (!wasCompletedViaUI) {
      const cleanup = cleanupHandles.get(connectionReference);
      if (cleanup) {
        await cleanup();
        cleanupHandles.delete(connectionReference);
      }
    } else {
      // Still remove the cleanup handle reference
      cleanupHandles.delete(connectionReference);
    }

    activeSessions.delete(connectionReference);

    return { success: true, id: session.id, recording: stored, alreadyStopped: wasCompletedViaUI };
  } catch (error: any) {
    return { success: false, error: error.message || String(error) };
  }
}

/**
 * Get a stored recording by ID
 */
export function getRecording(id: number): StoredRecording | undefined {
  return storedRecordings.get(id);
}

/**
 * Get all stored recordings
 */
export function listRecordings(): StoredRecording[] {
  return Array.from(storedRecordings.values());
}

/**
 * Clear a stored recording
 */
export function clearRecording(id: number): boolean {
  return storedRecordings.delete(id);
}

/**
 * Clear all stored recordings
 */
export function clearAllRecordings(): number {
  const count = storedRecordings.size;
  storedRecordings.clear();
  return count;
}

/**
 * Get recording status for a connection
 */
export async function getRecordingStatus(
  page: Page,
  connectionReference: string
): Promise<{ isRecording: boolean; id?: number; eventCount?: number; duration?: number; isPaused?: boolean }> {
  const session = activeSessions.get(connectionReference);
  if (!session) {
    return { isRecording: false };
  }

  try {
    const status = await page.evaluate(() => {
      return {
        count: (globalThis as any).__cdpRecordingEvents?.length || 0,
        isPaused: (globalThis as any).__cdpRecordingPaused || false,
      };
    });

    return {
      isRecording: true,
      id: session.id,
      eventCount: status.count + session.events.length,
      duration: Date.now() - session.startTime,
      isPaused: status.isPaused,
    };
  } catch {
    return { isRecording: true, id: session.id, duration: Date.now() - session.startTime };
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

function calculateSummary(events: InputEvent[]): StoredRecording['summary'] {
  let clicks = 0;
  let drags = 0;
  let scrolls = 0;
  let keyPresses = 0;
  let navigations = 0;
  let comments = 0;

  let inDrag = false;
  let lastMouseDown: MouseEvent | null = null;

  for (const event of events) {
    if (isCommentEvent(event)) {
      comments++;
    } else if (isNavigationEvent(event)) {
      navigations++;
    } else if (isKeyboardEvent(event)) {
      if (event.type === 'keydown') keyPresses++;
    } else if (isMouseEvent(event)) {
      if (event.type === 'mousedown') {
        inDrag = true;
        lastMouseDown = event;
      } else if (event.type === 'mouseup' && inDrag && lastMouseDown) {
        const distance = Math.sqrt(
          Math.pow(event.x - lastMouseDown.x, 2) + Math.pow(event.y - lastMouseDown.y, 2)
        );
        if (distance > 5) drags++;
        inDrag = false;
      } else if (event.type === 'click') {
        clicks++;
      } else if (event.type === 'wheel') {
        scrolls++;
      }
    }
  }

  return { clicks, drags, scrolls, keyPresses, navigations, comments };
}

// =============================================================================
// Event Processing (from mouse-recorder.ts)
// =============================================================================

export function simplifyEvents(
  events: InputEvent[],
  options: { distanceThreshold?: number; timeThreshold?: number; scrollTimeThreshold?: number } = {}
): InputEvent[] {
  const { distanceThreshold = 10, timeThreshold = 100, scrollTimeThreshold = 150 } = options;
  const simplified: InputEvent[] = [];
  let lastMove: MouseEvent | null = null;
  let pendingScroll: MouseEvent | null = null;

  const flushPending = () => {
    if (lastMove) {
      simplified.push(lastMove);
      lastMove = null;
    }
    if (pendingScroll) {
      simplified.push(pendingScroll);
      pendingScroll = null;
    }
  };

  for (const event of events) {
    if (isKeyboardEvent(event) || isNavigationEvent(event) || isCommentEvent(event)) {
      flushPending();
      simplified.push(event);
      continue;
    }

    if (isMouseEvent(event)) {
      if (event.type === 'wheel') {
        // Consolidate consecutive wheel events within time threshold
        if (lastMove) {
          simplified.push(lastMove);
          lastMove = null;
        }
        if (!pendingScroll) {
          pendingScroll = { ...event };
        } else {
          const timeDiff = event.timestamp - pendingScroll.timestamp;
          if (timeDiff <= scrollTimeThreshold) {
            // Accumulate scroll deltas
            pendingScroll.deltaX = (pendingScroll.deltaX || 0) + (event.deltaX || 0);
            pendingScroll.deltaY = (pendingScroll.deltaY || 0) + (event.deltaY || 0);
            pendingScroll.timestamp = event.timestamp; // Update to latest timestamp
          } else {
            // Time gap too large, push previous and start new
            simplified.push(pendingScroll);
            pendingScroll = { ...event };
          }
        }
      } else if (event.type === 'mousemove') {
        if (pendingScroll) {
          simplified.push(pendingScroll);
          pendingScroll = null;
        }
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
            lastMove = event;
          }
        }
      } else {
        // click, mousedown, mouseup, dblclick
        flushPending();
        simplified.push(event);
      }
    }
  }

  flushPending();
  return simplified;
}

export interface CommandConversionOptions {
  simplify?: boolean;
  includeHovers?: boolean;
  preferCoordinates?: boolean;
  preferSelectors?: boolean;
  includeDelays?: boolean;
  startTime?: number;
}

export function eventsToCommands(
  events: InputEvent[],
  options: CommandConversionOptions = {}
): Array<{ tool: string; params: Record<string, any>; delay?: number; comment?: string }> {
  const { simplify = true, includeHovers = false, preferCoordinates = false, preferSelectors = false, includeDelays = false, startTime } = options;
  const processedEvents = simplify ? simplifyEvents(events) : events;
  const commands: Array<{ tool: string; params: Record<string, any>; delay?: number; comment?: string }> = [];

  const baseTime = startTime || (processedEvents.length > 0 ? processedEvents[0].timestamp : 0);
  let lastTimestamp = baseTime;

  const addCommand = (cmd: { tool: string; params: Record<string, any> }, eventTimestamp: number) => {
    if (includeDelays) {
      const delay = eventTimestamp - lastTimestamp;
      if (delay > 0) {
        commands.push({ ...cmd, delay });
      } else {
        commands.push(cmd);
      }
      lastTimestamp = eventTimestamp;
    } else {
      commands.push(cmd);
    }
  };

  let i = 0;
  while (i < processedEvents.length) {
    const event = processedEvents[i];

    // Comment events - attach to the last meaningful command (skip modifier-only keys)
    if (isCommentEvent(event)) {
      // Find the last meaningful command (not a modifier-only keypress)
      for (let j = commands.length - 1; j >= 0; j--) {
        const cmd = commands[j];
        // Skip modifier-only keypresses like Meta+Meta, Shift+Meta+Shift
        if (cmd.tool === 'input' && cmd.params.action === 'press') {
          const key = cmd.params.key as string;
          if (key && /^(Meta|Shift|Control|Alt)(\+(Meta|Shift|Control|Alt))*$/.test(key)) {
            continue; // Skip this command, look for previous
          }
        }
        // Found a meaningful command - attach comment
        if (cmd.comment) {
          cmd.comment += '\n' + event.text;
        } else {
          cmd.comment = event.text;
        }
        break;
      }
      i++;
      continue;
    }

    // Navigation events
    if (isNavigationEvent(event)) {
      if (event.type === 'navigation') {
        addCommand({ tool: 'navigate', params: { action: 'goto', url: event.url } }, event.timestamp);
      } else if (event.type === 'reload') {
        addCommand({ tool: 'navigate', params: { action: 'reload' } }, event.timestamp);
      }
      i++;
      continue;
    }

    // Keyboard events
    if (isKeyboardEvent(event)) {
      if (event.type === 'keydown') {
        if (event.key.length === 1 && !event.modifiers?.ctrl && !event.modifiers?.alt && !event.modifiers?.meta) {
          let typedText = event.key;
          let j = i + 1;
          while (j < processedEvents.length) {
            const next = processedEvents[j];
            if (isKeyboardEvent(next) && next.type === 'keydown' &&
                next.key.length === 1 && !next.modifiers?.ctrl && !next.modifiers?.alt && !next.modifiers?.meta) {
              typedText += next.key;
              j++;
            } else if (isKeyboardEvent(next) && next.type === 'keyup') {
              j++;
            } else {
              break;
            }
          }
          if (typedText.length > 1) {
            addCommand({ tool: 'input', params: { action: 'type', text: typedText } }, event.timestamp);
            i = j;
            continue;
          }
        }
        const key = event.key;
        const modifiers = event.modifiers;
        let keyCombo = key;
        if (modifiers) {
          const parts: string[] = [];
          if (modifiers.ctrl) parts.push('Control');
          if (modifiers.alt) parts.push('Alt');
          if (modifiers.shift && key.length > 1) parts.push('Shift');
          if (modifiers.meta) parts.push('Meta');
          if (parts.length > 0) keyCombo = parts.join('+') + '+' + key;
        }
        addCommand({ tool: 'input', params: { action: 'press', key: keyCombo } }, event.timestamp);
      }
      i++;
      continue;
    }

    // Mouse events
    if (!isMouseEvent(event)) {
      i++;
      continue;
    }

    // Drag detection
    if (event.type === 'mousedown') {
      const dragStart = { x: event.x, y: event.y };
      let dragEnd = dragStart;
      let j = i + 1;

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

        const distance = Math.sqrt(
          Math.pow(dragEnd.x - dragStart.x, 2) + Math.pow(dragEnd.y - dragStart.y, 2)
        );

        if (distance > 5) {
          addCommand({ tool: 'input', params: { action: 'drag', from: dragStart, to: dragEnd } }, event.timestamp);
        }
        i = j + 1;
        continue;
      }
    }

    // Scroll
    if (event.type === 'wheel' && (event.deltaX || event.deltaY)) {
      addCommand({
        tool: 'input',
        params: { action: 'scroll', x: event.x, y: event.y, deltaX: event.deltaX || 0, deltaY: event.deltaY || 0 },
      }, event.timestamp);
      i++;
      continue;
    }

    // Click
    if (event.type === 'click') {
      const elementInfo = event.elementInfo;
      const selector = elementInfo?.selector;
      const isCanvas = elementInfo?.isCanvas;

      const useSelector = selector && !preferCoordinates && !isCanvas && (preferSelectors || elementInfo?.isInteractive);

      if (useSelector) {
        addCommand({ tool: 'input', params: { action: 'click', selector } }, event.timestamp);
      } else {
        // Coordinate-based click for canvas/3D elements
        addCommand({ tool: 'input', params: { action: 'click', x: event.x, y: event.y } }, event.timestamp);
      }
      i++;
      continue;
    }

    // Mousemove (hover)
    if (event.type === 'mousemove' && includeHovers) {
      addCommand({ tool: 'input', params: { action: 'mousemove', x: event.x, y: event.y } }, event.timestamp);
    }

    i++;
  }

  return commands;
}

export function formatEventsForReview(events: InputEvent[], startTime?: number): string {
  const lines: string[] = [];
  let eventNum = 0;
  const baseTime = startTime || (events.length > 0 ? events[0].timestamp : 0);

  for (const event of events) {
    const ms = event.timestamp - baseTime;

    // Navigation events
    if (isNavigationEvent(event)) {
      eventNum++;
      lines.push(`### ${eventNum}. ${event.type.toUpperCase()} @ ${ms}ms`);
      lines.push(`URL: \`${event.url}\``);
      if (event.previousUrl) lines.push(`From: \`${event.previousUrl}\``);
      lines.push('');
      continue;
    }

    // Comment events
    if (isCommentEvent(event)) {
      eventNum++;
      lines.push(`### ${eventNum}. COMMENT @ ${ms}ms`);
      lines.push(`> ${event.text}`);
      lines.push('');
      continue;
    }

    // Keyboard events
    if (isKeyboardEvent(event)) {
      if (event.type === 'keyup') continue;
      eventNum++;
      let keyDisplay = event.key;
      if (event.modifiers) {
        const mods: string[] = [];
        if (event.modifiers.ctrl) mods.push('Ctrl');
        if (event.modifiers.alt) mods.push('Alt');
        if (event.modifiers.shift) mods.push('Shift');
        if (event.modifiers.meta) mods.push('Cmd');
        if (mods.length > 0) keyDisplay = mods.join('+') + '+' + keyDisplay;
      }
      lines.push(`### ${eventNum}. KEY \`${keyDisplay}\` @ ${ms}ms`);
      if (event.targetInfo) {
        lines.push(`Target: \`${event.targetInfo.tag}${event.targetInfo.id ? '#' + event.targetInfo.id : ''}\``);
        if (event.targetInfo.isInput) lines.push(`Type: **Input field**`);
      }
      lines.push('');
      continue;
    }

    // Mouse events
    if (!isMouseEvent(event)) continue;
    if (event.type === 'mousemove') continue;

    eventNum++;
    const coords = `(${event.x}, ${event.y})`;
    const el = event.elementInfo;

    lines.push(`### ${eventNum}. ${event.type.toUpperCase()} at ${coords} @ ${ms}ms`);

    if (el) {
      lines.push(`Element: \`${el.tag}${el.id ? '#' + el.id : ''}${el.className ? '.' + el.className.split(' ')[0] : ''}\``);
      if (el.selector) {
        lines.push(`Selector: \`${el.selector}\` ✓`);
      } else {
        lines.push(`Selector: *(none available)*`);
      }
      if (el.isCanvas) lines.push(`Type: **Canvas/3D** - use coordinates`);
      else if (el.isInteractive) lines.push(`Type: **Interactive** - selector recommended`);
      if (el.text) lines.push(`Text: "${el.text.substring(0, 40)}${el.text.length > 40 ? '...' : ''}"`);
    }

    if (event.type === 'wheel') {
      lines.push(`Scroll: deltaX=${event.deltaX || 0}, deltaY=${event.deltaY || 0}`);
    }

    lines.push('');
  }

  return lines.join('\n');
}

export function formatEventsAsCSV(events: InputEvent[], startTime?: number): string {
  const baseTime = startTime || (events.length > 0 ? events[0].timestamp : 0);
  const lines: string[] = [];

  // Header
  lines.push('ms,type,x,y,key,selector,element,text,deltaX,deltaY,comment');

  for (const event of events) {
    const ms = event.timestamp - baseTime;

    if (isCommentEvent(event)) {
      const escapedText = event.text.replace(/"/g, '""');
      lines.push(`${ms},comment,,,,,,,"${escapedText}"`);
      continue;
    }

    if (isNavigationEvent(event)) {
      lines.push(`${ms},${event.type},,,,,"${event.url}",,,,`);
      continue;
    }

    if (isKeyboardEvent(event)) {
      if (event.type === 'keyup') continue;
      let keyDisplay = event.key;
      if (event.modifiers) {
        const mods: string[] = [];
        if (event.modifiers.ctrl) mods.push('Ctrl');
        if (event.modifiers.alt) mods.push('Alt');
        if (event.modifiers.shift) mods.push('Shift');
        if (event.modifiers.meta) mods.push('Cmd');
        if (mods.length > 0) keyDisplay = mods.join('+') + '+' + keyDisplay;
      }
      const target = event.targetInfo?.tag || '';
      lines.push(`${ms},key,,,${keyDisplay},,${target},,,,`);
      continue;
    }

    if (isMouseEvent(event)) {
      if (event.type === 'mousemove') continue;
      const el = event.elementInfo;
      const selector = el?.selector || '';
      const element = el?.tag || '';
      const text = el?.text ? `"${el.text.substring(0, 30).replace(/"/g, '""')}"` : '';
      const deltaX = event.deltaX || '';
      const deltaY = event.deltaY || '';
      lines.push(`${ms},${event.type},${event.x},${event.y},,${selector},${element},${text},${deltaX},${deltaY},`);
    }
  }

  return lines.join('\n');
}

/**
 * Generate a condensed timeline of events, grouping consecutive actions of the same type
 * but showing actual comment text inline.
 * Example: "3 clicks → 5 keys → 'testing this feature' → 2 clicks → 'done testing'"
 */
export function generateCondensedTimeline(events: InputEvent[]): string {
  const simplified = simplifyEvents(events);
  const parts: string[] = [];

  let currentType: string | null = null;
  let currentCount = 0;

  const flushCurrent = () => {
    if (currentType && currentCount > 0) {
      if (currentCount === 1) {
        parts.push(`1 ${currentType}`);
      } else {
        parts.push(`${currentCount} ${currentType}s`);
      }
    }
    currentType = null;
    currentCount = 0;
  };

  for (const event of simplified) {
    if (isCommentEvent(event)) {
      flushCurrent();
      // Truncate long comments
      const text = event.text.length > 50 ? event.text.substring(0, 47) + '...' : event.text;
      const category = event.category || 'narrative';
      if (category === 'bug') {
        parts.push(`BUG: "${text}"`);
      } else if (category === 'feature') {
        parts.push(`FEATURE: "${text}"`);
      } else {
        parts.push(`"${text}"`);
      }
      continue;
    }

    if (isNavigationEvent(event)) {
      flushCurrent();
      parts.push(`nav`);
      continue;
    }

    let eventType: string;
    if (isKeyboardEvent(event)) {
      if (event.type === 'keyup') continue;
      eventType = 'key';
    } else if (isMouseEvent(event)) {
      if (event.type === 'click') {
        eventType = 'click';
      } else if (event.type === 'wheel') {
        eventType = 'scroll';
      } else if (event.type === 'mousemove') {
        continue; // Skip mousemove
      } else {
        continue; // Skip mousedown/mouseup
      }
    } else {
      continue;
    }

    if (eventType === currentType) {
      currentCount++;
    } else {
      flushCurrent();
      currentType = eventType;
      currentCount = 1;
    }
  }

  flushCurrent();

  return parts.join(' → ');
}
