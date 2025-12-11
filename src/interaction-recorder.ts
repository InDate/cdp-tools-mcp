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
import { getIssue } from './issue-tracker.js';
import { showOverlay, getWorkOnNoSequenceConfig } from './overlays.js';

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
  abortSignal?: AbortSignal;
  issueId?: number;  // If provided, looks up issue and shows fullscreen overlay
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

let nextRecordingId = 1;

// Cleanup handles for page listeners
const cleanupHandles = new Map<string, () => Promise<void>>();

// Cancel callbacks for active recordings
const cancelCallbacks = new Map<string, () => Promise<void>>();

/**
 * Cancel an active recording without saving
 */
export async function cancelRecording(connectionReference: string): Promise<boolean> {
  const cancel = cancelCallbacks.get(connectionReference);
  if (cancel) {
    await cancel();
    return true;
  }
  return false;
}

/**
 * Cancel all active recordings
 */
export async function cancelAllRecordings(): Promise<number> {
  const count = cancelCallbacks.size;
  for (const cancel of cancelCallbacks.values()) {
    await cancel();
  }
  return count;
}

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
): Promise<{ success: boolean; id?: number; recording?: StoredRecording; error?: string; cancelled?: boolean }> {
  // If there's an orphaned recording (e.g., MCP didn't send abort signal), clean it up
  if (activeSessions.has(connectionReference)) {
    await cancelRecording(connectionReference);
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

  // If issueId is provided, look up the issue and show a "Ready to begin?" overlay
  if (options.issueId) {
    const issue = await getIssue(options.issueId);
    if (issue) {
      const overlayConfig = getWorkOnNoSequenceConfig(issue.type, issue.id, issue.description);
      // Customize for recording context
      overlayConfig.title = `Recording for ${issue.type === 'bug' ? 'Bug' : 'Feature'} #${issue.id}`;
      overlayConfig.instructions = 'Click BEGIN to start recording your actions.';
      overlayConfig.buttons = [
        { id: 'cancel', label: 'CANCEL', action: 'cancel' },
        { id: 'begin', label: 'BEGIN RECORDING', action: 'record', primary: true },
      ];

      const result = await showOverlay(page, overlayConfig);

      if (result.action === 'cancel') {
        activeSessions.delete(connectionReference);
        return { success: false, cancelled: true };
      }
    }
  }

  const showOverlayOption = options.showOverlay ?? true;

  // Create a promise that will resolve when recording completes or is cancelled
  let resolveRecording: (result: { success: boolean; id?: number; recording?: StoredRecording; error?: string; cancelled?: boolean }) => void;
  const recordingPromise = new Promise<{ success: boolean; id?: number; recording?: StoredRecording; error?: string; cancelled?: boolean }>((resolve) => {
    resolveRecording = resolve;
  });

  // Store cancel callback for external cancellation
  const cancelFn = async () => {
    // Clean up without creating a recording
    const cleanup = cleanupHandles.get(connectionReference);
    if (cleanup) {
      await cleanup().catch(() => {});
      cleanupHandles.delete(connectionReference);
    }
    activeSessions.delete(connectionReference);
    cancelCallbacks.delete(connectionReference);
    resolveRecording({ success: false, cancelled: true });
  };
  cancelCallbacks.set(connectionReference, cancelFn);

  // Listen for abort signal from MCP (tool cancellation)
  if (options.abortSignal) {
    options.abortSignal.addEventListener('abort', () => {
      cancelFn();
    }, { once: true });
  }

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

    // Set up bindings for UI buttons to call back to server
    await client.send('Runtime.addBinding', { name: '__cdpRecordingComplete' });
    await client.send('Runtime.addBinding', { name: '__cdpRecordingCancel' });

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

      if (event.name === '__cdpRecordingCancel') {
        // Cancel button was clicked - clean up without saving
        cleanupHandles.delete(connectionReference);
        activeSessions.delete(connectionReference);
        cancelCallbacks.delete(connectionReference);
        resolveRecording({ success: false, cancelled: true });
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

        // Use stored references (set after DOM creation)
        const statsEl = (globalThis as any).__cdpStatsEl;
        const eventEl = (globalThis as any).__cdpEventEl;
        const statusEl = (globalThis as any).__cdpStatusEl;

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
        overlay.style.cssText = 'opacity: 1 !important;';

        // Build overlay using DOM methods (Trusted Types compatible)
        const panel = doc.createElement('div');
        panel.className = 'cdp-panel';
        panel.style.cssText = `
          position: fixed !important;
          bottom: 10px !important;
          left: 50% !important;
          transform: translateX(-50%) !important;
          background: rgba(0, 0, 0, 0.9) !important;
          color: white !important;
          padding: 6px 12px !important;
          border-radius: 20px !important;
          font-family: -apple-system, system-ui, sans-serif !important;
          font-size: 12px !important;
          z-index: 2147483647 !important;
          display: flex !important;
          align-items: center !important;
          gap: 10px !important;
          box-shadow: 0 2px 8px rgba(0,0,0,0.3) !important;
          backdrop-filter: blur(4px) !important;
          opacity: 1 !important;
        `;

        const statusEl = doc.createElement('span');
        statusEl.className = 'cdp-status';
        statusEl.textContent = 'REC';
        Object.assign(statusEl.style, {
          padding: '2px 6px',
          borderRadius: '4px',
          fontSize: '10px',
          fontWeight: '600',
          background: '#ef4444',
          letterSpacing: '0.5px'
        });

        const statsEl = doc.createElement('span');
        statsEl.className = 'cdp-stats';
        statsEl.textContent = '0 | 0.0s';
        Object.assign(statsEl.style, { color: '#d1d5db', minWidth: '60px' });

        const eventEl = doc.createElement('span');
        eventEl.className = 'cdp-event';
        eventEl.textContent = '-';
        Object.assign(eventEl.style, {
          padding: '2px 8px',
          borderRadius: '4px',
          fontSize: '10px',
          background: '#6b7280',
          minWidth: '50px',
          textAlign: 'center'
        });

        const btnContainer = doc.createElement('div');
        Object.assign(btnContainer.style, { display: 'flex', gap: '4px', marginLeft: '6px' });

        const btnStyle = {
          background: '#374151',
          border: 'none',
          color: 'white',
          width: '24px',
          height: '24px',
          borderRadius: '4px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '10px'
        };

        const commentBtn = doc.createElement('button');
        commentBtn.className = 'cdp-btn cdp-comment';
        commentBtn.title = 'Add Comment (Cmd+Shift+C) | Bug (Cmd+Shift+B) | Feature (Cmd+Shift+F)';
        commentBtn.textContent = '💬';
        Object.assign(commentBtn.style, btnStyle);

        const pauseBtn = doc.createElement('button');
        pauseBtn.className = 'cdp-btn cdp-pause';
        pauseBtn.title = 'Pause/Resume';
        pauseBtn.textContent = '⏸';
        Object.assign(pauseBtn.style, btnStyle);

        const resetBtn = doc.createElement('button');
        resetBtn.className = 'cdp-btn cdp-reset';
        resetBtn.title = 'Reset';
        resetBtn.textContent = '↺';
        Object.assign(resetBtn.style, btnStyle);

        const doneBtn = doc.createElement('button');
        doneBtn.className = 'cdp-btn cdp-done';
        doneBtn.title = 'Complete';
        doneBtn.textContent = '✓';
        Object.assign(doneBtn.style, { ...btnStyle, background: '#059669' });

        const cancelBtn = doc.createElement('button');
        cancelBtn.className = 'cdp-btn cdp-cancel';
        cancelBtn.title = 'Cancel (discard recording)';
        cancelBtn.textContent = '✕';
        Object.assign(cancelBtn.style, { ...btnStyle, background: '#dc2626' });

        btnContainer.appendChild(commentBtn);
        btnContainer.appendChild(pauseBtn);
        btnContainer.appendChild(resetBtn);
        btnContainer.appendChild(doneBtn);
        btnContainer.appendChild(cancelBtn);

        panel.appendChild(statusEl);
        panel.appendChild(statsEl);
        panel.appendChild(eventEl);
        panel.appendChild(btnContainer);

        // Comment modal
        const commentModal = doc.createElement('div');
        commentModal.className = 'cdp-comment-modal';
        commentModal.style.cssText = `
          display: none !important;
          position: fixed !important;
          top: 0 !important;
          left: 0 !important;
          width: 100% !important;
          height: 100% !important;
          background: rgba(0, 0, 0, 0.9) !important;
          z-index: 2147483648 !important;
          justify-content: center !important;
          align-items: center !important;
          font-family: -apple-system, system-ui, sans-serif !important;
          opacity: 1 !important;
        `;

        const modalCard = doc.createElement('div');
        modalCard.style.cssText = `
          background: #1f2937 !important;
          border-radius: 12px !important;
          padding: 24px !important;
          width: 90% !important;
          max-width: 500px !important;
          box-shadow: 0 25px 50px rgba(0,0,0,0.5) !important;
          opacity: 1 !important;
        `;

        const modalTitle = doc.createElement('h3');
        modalTitle.textContent = 'Add Comment';
        Object.assign(modalTitle.style, { margin: '0 0 16px 0', color: 'white', fontSize: '18px' });

        // Category buttons
        const categoryContainer = doc.createElement('div');
        categoryContainer.className = 'cdp-comment-category';
        Object.assign(categoryContainer.style, { display: 'flex', gap: '0', marginBottom: '16px' });

        const categories = [
          { value: 'narrative', label: 'NARRATIVE', borderRadius: '6px 0 0 6px' },
          { value: 'bug', label: 'BUG', borderRadius: '0' },
          { value: 'feature', label: 'FEATURE', borderRadius: '0 6px 6px 0' }
        ];

        const categoryRadios: any[] = [];
        const categoryBtnsArr: any[] = [];

        categories.forEach((cat, i) => {
          const label = doc.createElement('label');
          Object.assign(label.style, { flex: '1', cursor: 'pointer' });

          const radio = doc.createElement('input');
          radio.type = 'radio';
          radio.name = 'cdp-category';
          radio.value = cat.value;
          if (i === 0) radio.checked = true;
          radio.style.display = 'none';
          categoryRadios.push(radio);

          const span = doc.createElement('span');
          span.className = 'cdp-cat-btn';
          span.dataset.cat = cat.value;
          span.textContent = cat.label;
          Object.assign(span.style, {
            display: 'block',
            textAlign: 'center',
            padding: '8px 12px',
            background: i === 0 ? '#3b82f6' : '#374151',
            color: i === 0 ? 'white' : '#9ca3af',
            fontSize: '13px',
            fontWeight: '500',
            borderRadius: cat.borderRadius,
            border: i === 0 ? '1px solid #3b82f6' : '1px solid #4b5563'
          });
          categoryBtnsArr.push(span);

          label.appendChild(radio);
          label.appendChild(span);
          categoryContainer.appendChild(label);
        });

        const commentInput = doc.createElement('textarea') as any;
        commentInput.className = 'cdp-comment-input';
        commentInput.placeholder = "e.g., 'Expected the form to show a success message'";
        Object.assign(commentInput.style, {
          width: '100%',
          height: '120px',
          background: '#374151',
          border: '1px solid #4b5563',
          borderRadius: '8px',
          color: 'white',
          padding: '12px',
          fontSize: '14px',
          resize: 'vertical',
          boxSizing: 'border-box'
        });

        const modalBtnContainer = doc.createElement('div');
        Object.assign(modalBtnContainer.style, { display: 'flex', gap: '12px', marginTop: '16px', justifyContent: 'flex-end' });

        const commentCancel = doc.createElement('button');
        commentCancel.className = 'cdp-comment-cancel';
        commentCancel.textContent = 'Cancel';
        Object.assign(commentCancel.style, {
          background: '#374151',
          border: 'none',
          color: 'white',
          padding: '8px 16px',
          borderRadius: '6px',
          cursor: 'pointer',
          fontSize: '14px'
        });

        const commentSave = doc.createElement('button');
        commentSave.className = 'cdp-comment-save';
        commentSave.textContent = 'Save Comment';
        Object.assign(commentSave.style, {
          background: '#3b82f6',
          border: 'none',
          color: 'white',
          padding: '8px 16px',
          borderRadius: '6px',
          cursor: 'pointer',
          fontSize: '14px'
        });

        modalBtnContainer.appendChild(commentCancel);
        modalBtnContainer.appendChild(commentSave);

        modalCard.appendChild(modalTitle);
        modalCard.appendChild(categoryContainer);
        modalCard.appendChild(commentInput);
        modalCard.appendChild(modalBtnContainer);
        commentModal.appendChild(modalCard);

        overlay.appendChild(panel);
        overlay.appendChild(commentModal);
        doc.body.appendChild(overlay);

        // Store references for updateOverlay
        (globalThis as any).__cdpStatusEl = statusEl;
        (globalThis as any).__cdpStatsEl = statsEl;
        (globalThis as any).__cdpEventEl = eventEl;

        const categoryBtns = categoryBtnsArr;

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
            panel.textContent = '';
            const span = doc.createElement('span');
            span.style.padding = '4px 8px';
            span.textContent = 'Saved';
            panel.appendChild(span);
            // Remove overlay after brief delay
            setTimeout(() => {
              overlay.remove();
            }, 800);
          }
        });

        cancelBtn?.addEventListener('click', (e: any) => {
          e.stopPropagation();
          (globalThis as any).__cdpRecordingState = 'cancelled';

          // Send cancel signal to server via CDP binding
          try {
            (globalThis as any).__cdpRecordingCancel();
          } catch (err) {
            console.error('[cdp-tools] Failed to send cancel to server:', err);
          }

          const panel = overlay.querySelector('.cdp-panel');
          if (panel) {
            panel.style.background = 'rgba(220, 38, 38, 0.9)';
            panel.textContent = '';
            const span = doc.createElement('span');
            span.style.padding = '4px 8px';
            span.textContent = 'Cancelled';
            panel.appendChild(span);
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
    }, showOverlayOption);

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
      const dragStart = { x: Math.max(0, event.x), y: Math.max(0, event.y) };
      let dragEnd = dragStart;
      let j = i + 1;

      while (j < processedEvents.length && processedEvents[j].type !== 'mouseup') {
        const nextEvent = processedEvents[j];
        if (isMouseEvent(nextEvent) && nextEvent.type === 'mousemove') {
          // Clamp coordinates to valid viewport bounds (negative coords are outside viewport)
          dragEnd = { x: Math.max(0, nextEvent.x), y: Math.max(0, nextEvent.y) };
        }
        j++;
      }

      if (j < processedEvents.length && processedEvents[j].type === 'mouseup') {
        const mouseup = processedEvents[j];
        if (isMouseEvent(mouseup)) {
          // Clamp coordinates to valid viewport bounds
          dragEnd = { x: Math.max(0, mouseup.x), y: Math.max(0, mouseup.y) };
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

// =============================================================================
// Verification Overlay
// =============================================================================

export interface VerificationResult {
  resolved: boolean;
  comment?: string;
}

/**
 * Show a verification overlay on the page asking the user to confirm
 * whether an issue is resolved.
 */
export async function showVerificationOverlay(
  page: Page,
  issueType: 'bug' | 'feature',
  issueDescription: string,
  issueId: number
): Promise<VerificationResult> {
  const typeLabel = issueType === 'bug' ? 'Bug' : 'Feature';
  const questionText = issueType === 'bug'
    ? 'Is this bug fixed to your satisfaction?'
    : 'Is this feature implemented to your satisfaction?';

  return await page.evaluate((params: {
    typeLabel: string;
    issueDescription: string;
    issueId: number;
    questionText: string;
  }) => {
    return new Promise<{ resolved: boolean; comment?: string }>((resolve) => {
      const doc = (globalThis as any).document;

      // Remove any existing overlays (including replay overlay that may still be present)
      const existing = doc.getElementById('__cdp-verification-overlay');
      if (existing) existing.remove();
      const replayOverlay = doc.getElementById('__cdp-replay-overlay');
      if (replayOverlay) replayOverlay.remove();

      // Also clean up replay overlay event listeners if present
      const blocker = (globalThis as any).__cdpReplayBlocker;
      if (blocker) {
        blocker.feedbackEvents?.forEach((evt: string) => doc.removeEventListener(evt, blocker.blockWithFeedback, true));
        blocker.silentBlockEvents?.forEach((evt: string) => doc.removeEventListener(evt, blocker.blockSilently, true));
        delete (globalThis as any).__cdpReplayBlocker;
      }
      const style = (globalThis as any).__cdpReplayStyle;
      if (style) {
        style.remove();
        delete (globalThis as any).__cdpReplayStyle;
      }

      // Create elements using DOM methods (Trusted Types compatible)
      const overlay = doc.createElement('div');
      overlay.id = '__cdp-verification-overlay';
      overlay.style.cssText = 'opacity: 1 !important;';

      const backdrop = doc.createElement('div');
      backdrop.style.cssText = `
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        right: 0 !important;
        bottom: 0 !important;
        background: #424242 !important;
        z-index: 2147483646 !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        font-family: Roboto, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important;
        opacity: 1 !important;
      `;

      const card = doc.createElement('div');
      card.style.cssText = `
        background: #ffffff !important;
        border-radius: 4px !important;
        padding: 24px !important;
        max-width: 480px !important;
        width: 90% !important;
        box-shadow: 0 11px 15px -7px rgba(0,0,0,0.2), 0 24px 38px 3px rgba(0,0,0,0.14), 0 9px 46px 8px rgba(0,0,0,0.12) !important;
        color: #212121 !important;
        opacity: 1 !important;
      `;

      // Header
      const header = doc.createElement('div');
      header.style.cssText = 'margin-bottom: 16px !important; text-align: center !important; opacity: 1 !important;';

      const typeLabel = doc.createElement('div');
      typeLabel.textContent = `${params.typeLabel} #${params.issueId}`;
      typeLabel.style.cssText = `
        font-size: 12px !important;
        color: #757575 !important;
        text-transform: uppercase !important;
        letter-spacing: 0.5px !important;
        margin-bottom: 8px !important;
        opacity: 1 !important;
      `;

      const description = doc.createElement('div');
      description.textContent = params.issueDescription;
      description.style.cssText = `
        font-size: 20px !important;
        font-weight: 500 !important;
        color: #212121 !important;
        line-height: 1.4 !important;
        text-align: center !important;
        opacity: 1 !important;
      `;

      header.appendChild(typeLabel);
      header.appendChild(description);

      // Question text (subtle styling)
      const questionBox = doc.createElement('div');
      questionBox.textContent = params.questionText;
      questionBox.style.cssText = `
        font-size: 14px !important;
        margin-bottom: 20px !important;
        padding: 12px 16px !important;
        background: #fafafa !important;
        border-radius: 4px !important;
        color: #757575 !important;
        opacity: 1 !important;
      `;

      // Comment textarea
      const commentInput = doc.createElement('textarea');
      commentInput.id = '__cdp-verify-comment';
      commentInput.placeholder = 'Add a comment (optional)';
      commentInput.style.cssText = `
        width: 100% !important;
        height: 80px !important;
        padding: 12px !important;
        border: 1px solid #e0e0e0 !important;
        border-radius: 4px !important;
        background: #fafafa !important;
        color: #212121 !important;
        font-size: 14px !important;
        resize: none !important;
        margin-bottom: 24px !important;
        box-sizing: border-box !important;
        outline: none !important;
        opacity: 1 !important;
      `;

      // Button container
      const buttonContainer = doc.createElement('div');
      buttonContainer.style.cssText = `
        display: flex !important;
        gap: 8px !important;
        justify-content: flex-end !important;
        opacity: 1 !important;
      `;

      // No button
      const noBtn = doc.createElement('button');
      noBtn.id = '__cdp-verify-no';
      noBtn.textContent = 'Not Fixed';
      noBtn.style.cssText = `
        min-width: 120px !important;
        height: 36px !important;
        padding: 0 16px !important;
        border-radius: 4px !important;
        border: none !important;
        font-size: 14px !important;
        font-weight: 500 !important;
        cursor: pointer !important;
        text-transform: uppercase !important;
        letter-spacing: 0.5px !important;
        background: #f5f5f5 !important;
        color: #616161 !important;
        opacity: 1 !important;
      `;

      // Yes button
      const yesBtn = doc.createElement('button');
      yesBtn.id = '__cdp-verify-yes';
      yesBtn.textContent = 'Fixed';
      yesBtn.style.cssText = `
        min-width: 120px !important;
        height: 36px !important;
        padding: 0 16px !important;
        border-radius: 4px !important;
        border: none !important;
        font-size: 14px !important;
        font-weight: 500 !important;
        cursor: pointer !important;
        text-transform: uppercase !important;
        letter-spacing: 0.5px !important;
        background: #1976d2 !important;
        color: #ffffff !important;
        opacity: 1 !important;
      `;

      buttonContainer.appendChild(noBtn);
      buttonContainer.appendChild(yesBtn);

      card.appendChild(header);
      card.appendChild(questionBox);
      card.appendChild(commentInput);
      card.appendChild(buttonContainer);
      backdrop.appendChild(card);
      overlay.appendChild(backdrop);
      doc.body.appendChild(overlay);

      // Block keyboard events from reaching the app
      const blockKeyboard = (e: any) => {
        e.stopPropagation();
      };
      doc.addEventListener('keydown', blockKeyboard, true);
      doc.addEventListener('keyup', blockKeyboard, true);
      doc.addEventListener('keypress', blockKeyboard, true);

      const cleanup = () => {
        doc.removeEventListener('keydown', blockKeyboard, true);
        doc.removeEventListener('keyup', blockKeyboard, true);
        doc.removeEventListener('keypress', blockKeyboard, true);
        overlay.remove();
      };

      yesBtn?.addEventListener('click', () => {
        const comment = commentInput?.value?.trim() || undefined;
        cleanup();
        resolve({ resolved: true, comment });
      });

      noBtn?.addEventListener('click', () => {
        const comment = commentInput?.value?.trim() || undefined;
        cleanup();
        resolve({ resolved: false, comment });
      });
    });
  }, { typeLabel, issueDescription, issueId, questionText });
}

export type TestReadyAction = 'cancel' | 'begin' | 'rerecord';

/**
 * Show a "Ready to begin?" overlay before starting a test replay
 * Uses DOM methods instead of innerHTML to support Trusted Types policies
 * Returns: 'cancel', 'begin', or 'rerecord'
 */
export async function showTestReadyOverlay(
  page: Page,
  issueType: 'bug' | 'feature',
  issueDescription: string,
  issueId: number,
  hasSequence: boolean = true
): Promise<TestReadyAction> {
  const typeLabel = issueType === 'bug' ? 'Bug' : 'Feature';

  return await page.evaluate((params: {
    typeLabel: string;
    issueDescription: string;
    issueId: number;
    hasSequence: boolean;
  }) => {
    return new Promise<'cancel' | 'begin' | 'rerecord'>((resolve) => {
      const doc = (globalThis as any).document;

      // Remove any existing overlay
      const existing = doc.getElementById('__cdp-test-ready-overlay');
      if (existing) existing.remove();

      // Create elements using DOM methods (Trusted Types compatible)
      const overlay = doc.createElement('div');
      overlay.id = '__cdp-test-ready-overlay';
      overlay.style.cssText = 'opacity: 1 !important;';

      const backdrop = doc.createElement('div');
      backdrop.style.cssText = `
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        right: 0 !important;
        bottom: 0 !important;
        background: #424242 !important;
        z-index: 2147483646 !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        font-family: Roboto, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important;
        opacity: 1 !important;
      `;

      const card = doc.createElement('div');
      card.style.cssText = `
        background: #ffffff !important;
        border-radius: 4px !important;
        padding: 24px !important;
        max-width: 480px !important;
        width: 90% !important;
        box-shadow: 0 11px 15px -7px rgba(0,0,0,0.2), 0 24px 38px 3px rgba(0,0,0,0.14), 0 9px 46px 8px rgba(0,0,0,0.12) !important;
        color: #212121 !important;
        text-align: center !important;
        opacity: 1 !important;
      `;

      const testingLabel = doc.createElement('div');
      testingLabel.textContent = `Testing ${params.typeLabel} #${params.issueId}`;
      testingLabel.style.cssText = `
        font-size: 12px !important;
        color: #757575 !important;
        text-transform: uppercase !important;
        letter-spacing: 0.5px !important;
        margin-bottom: 16px !important;
        opacity: 1 !important;
      `;

      const description = doc.createElement('div');
      description.textContent = params.issueDescription;
      description.style.cssText = `
        font-size: 18px !important;
        font-weight: 500 !important;
        margin-bottom: 20px !important;
        padding: 16px !important;
        background: #f5f5f5 !important;
        border-radius: 4px !important;
        color: #212121 !important;
        text-align: center !important;
        opacity: 1 !important;
      `;

      const instructions = doc.createElement('div');
      instructions.textContent = params.hasSequence
        ? 'The recorded sequence will replay. Watch for the issue.'
        : 'Recording will start. Reproduce the issue to verify.';
      instructions.style.cssText = `
        font-size: 14px !important;
        color: #616161 !important;
        margin-bottom: 24px !important;
        opacity: 1 !important;
      `;

      // Button container
      const buttonContainer = doc.createElement('div');
      buttonContainer.style.cssText = `
        display: flex !important;
        gap: 8px !important;
        justify-content: center !important;
        opacity: 1 !important;
      `;

      const buttonBaseCss = `
        min-width: 100px !important;
        height: 36px !important;
        padding: 0 16px !important;
        border-radius: 4px !important;
        border: none !important;
        font-size: 14px !important;
        font-weight: 500 !important;
        cursor: pointer !important;
        text-transform: uppercase !important;
        letter-spacing: 0.5px !important;
        opacity: 1 !important;
      `;

      const cancelBtn = doc.createElement('button');
      cancelBtn.textContent = 'CANCEL';
      cancelBtn.style.cssText = buttonBaseCss + 'background: #f5f5f5 !important; color: #616161 !important;';

      // Only show re-record button if there's already a sequence
      let rerecordBtn: any = null;
      if (params.hasSequence) {
        rerecordBtn = doc.createElement('button');
        rerecordBtn.textContent = 'RE-RECORD';
        rerecordBtn.style.cssText = buttonBaseCss + 'background: #ff9800 !important; color: #ffffff !important;';
      }

      const beginBtn = doc.createElement('button');
      beginBtn.textContent = 'BEGIN TEST';
      beginBtn.id = '__cdp-test-begin';
      beginBtn.style.cssText = buttonBaseCss + 'background: #1976d2 !important; color: #ffffff !important;';

      buttonContainer.appendChild(cancelBtn);
      if (rerecordBtn) buttonContainer.appendChild(rerecordBtn);
      buttonContainer.appendChild(beginBtn);

      card.appendChild(testingLabel);
      card.appendChild(description);
      card.appendChild(instructions);
      card.appendChild(buttonContainer);
      backdrop.appendChild(card);
      overlay.appendChild(backdrop);
      doc.body.appendChild(overlay);

      // Block keyboard events from reaching the app
      const blockKeyboard = (e: any) => {
        e.stopPropagation();
      };
      doc.addEventListener('keydown', blockKeyboard, true);
      doc.addEventListener('keyup', blockKeyboard, true);
      doc.addEventListener('keypress', blockKeyboard, true);

      const cleanup = () => {
        doc.removeEventListener('keydown', blockKeyboard, true);
        doc.removeEventListener('keyup', blockKeyboard, true);
        doc.removeEventListener('keypress', blockKeyboard, true);
        overlay.remove();
      };

      cancelBtn.addEventListener('click', () => {
        cleanup();
        resolve('cancel');
      });

      if (rerecordBtn) {
        rerecordBtn.addEventListener('click', () => {
          cleanup();
          resolve('rerecord');
        });
      }

      beginBtn.addEventListener('click', () => {
        cleanup();
        resolve('begin');
      });
    });
  }, { typeLabel, issueDescription, issueId, hasSequence });
}

/**
 * Show a "Replay in progress" overlay that blocks user interaction
 * Returns a cleanup function to remove the overlay
 */
export async function showReplayOverlay(
  page: Page,
  issueType: 'bug' | 'feature',
  issueDescription: string,
  issueId: number
): Promise<() => Promise<void>> {
  const typeLabel = issueType === 'bug' ? 'Bug' : 'Feature';

  await page.evaluate((params: {
    typeLabel: string;
    issueDescription: string;
    issueId: number;
  }) => {
    const doc = (globalThis as any).document;

    // Create overlay - transparent with banner at top
    const overlay = doc.createElement('div');
    overlay.id = '__cdp-replay-overlay';
    Object.assign(overlay.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '100%',
      height: '100%',
      background: 'transparent',
      zIndex: '2147483647',
      pointerEvents: 'auto',
      fontFamily: '"Roboto", -apple-system, system-ui, sans-serif'
    });

    // Banner at top (not centered)
    const card = doc.createElement('div');
    Object.assign(card.style, {
      position: 'absolute',
      top: '16px',
      left: '50%',
      transform: 'translateX(-50%)',
      background: 'rgba(33, 33, 33, 0.9)',
      borderRadius: '8px',
      padding: '12px 24px',
      maxWidth: '400px',
      boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
      textAlign: 'center',
      display: 'flex',
      alignItems: 'center',
      gap: '12px'
    });

    // Spinner (small, inline)
    const spinner = doc.createElement('div');
    Object.assign(spinner.style, {
      width: '20px',
      height: '20px',
      border: '2px solid rgba(255,255,255,0.3)',
      borderTop: '2px solid #4fc3f7',
      borderRadius: '50%',
      animation: 'cdp-spin 1s linear infinite',
      flexShrink: '0'
    });

    // Add keyframe animations (spin for spinner, shake for feedback)
    const style = doc.createElement('style');
    style.textContent = `
      @keyframes cdp-spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
      @keyframes cdp-shake { 0%, 100% { transform: translateX(0); } 20% { transform: translateX(-4px); } 40% { transform: translateX(4px); } 60% { transform: translateX(-4px); } 80% { transform: translateX(4px); } }
    `;
    doc.head.appendChild(style);
    (globalThis as any).__cdpReplayStyle = style;

    // Instructions/status text
    const instructions = doc.createElement('div');
    instructions.textContent = `Replaying ${params.typeLabel} #${params.issueId}...`;
    Object.assign(instructions.style, {
      fontSize: '14px',
      color: '#ffffff',
      whiteSpace: 'nowrap'
    });

    card.appendChild(spinner);
    card.appendChild(instructions);
    overlay.appendChild(card);
    doc.body.appendChild(overlay);

    // Block all user interactions with escalating feedback
    let attemptCount = 0;
    const attitudeMessages = [
      "I said WAIT.",
      "Seriously?",
      "The spinner means BUSY.",
      "Do you want bugs? Because this is how you get bugs.",
      "...",
    ];

    // Events that trigger shake/attitude (intentional user actions)
    const feedbackEvents = ['click', 'keydown', 'touchend'];
    // Events to block silently (prevent default but no feedback)
    const silentBlockEvents = ['mousedown', 'mouseup', 'keyup', 'keypress', 'touchstart'];

    const blockWithFeedback = (e: any) => {
      e.preventDefault();
      e.stopPropagation();
      attemptCount++;

      // Shake the instructions text
      instructions.style.animation = 'none';
      void (instructions as any).offsetWidth; // Force reflow
      instructions.style.animation = 'cdp-shake 0.3s ease';

      // After 3 attempts, show attitude
      if (attemptCount > 3) {
        const msgIndex = Math.min(attemptCount - 4, attitudeMessages.length - 1);
        instructions.textContent = attitudeMessages[msgIndex];
        instructions.style.color = '#d32f2f';
      }
    };

    const blockSilently = (e: any) => {
      e.preventDefault();
      e.stopPropagation();
    };

    feedbackEvents.forEach(evt => doc.addEventListener(evt, blockWithFeedback, true));
    silentBlockEvents.forEach(evt => doc.addEventListener(evt, blockSilently, true));
    (globalThis as any).__cdpReplayBlocker = {
      blockWithFeedback,
      blockSilently,
      feedbackEvents,
      silentBlockEvents
    };
  }, { typeLabel, issueDescription, issueId });

  // Return cleanup function
  return async () => {
    await page.evaluate(() => {
      const doc = (globalThis as any).document;
      const overlay = doc.getElementById('__cdp-replay-overlay');
      if (overlay) overlay.remove();

      const style = (globalThis as any).__cdpReplayStyle;
      if (style) style.remove();

      const blocker = (globalThis as any).__cdpReplayBlocker;
      if (blocker) {
        blocker.feedbackEvents.forEach((evt: string) => doc.removeEventListener(evt, blocker.blockWithFeedback, true));
        blocker.silentBlockEvents.forEach((evt: string) => doc.removeEventListener(evt, blocker.blockSilently, true));
        delete (globalThis as any).__cdpReplayBlocker;
      }
      delete (globalThis as any).__cdpReplayStyle;
    }).catch(() => {});
  };
}
