/**
 * Shared overlay system for devharness
 * Provides consistent UI for issue workflows (workOn, resolve, replay)
 */

import type { Page } from 'puppeteer-core';

// =============================================================================
// Types
// =============================================================================

export type OverlayAction = 'cancel' | 'record' | 'explore' | 'begin' | 'yes' | 'no';

export interface OverlayButton {
  id: string;
  label: string;
  action: OverlayAction;
  primary?: boolean;  // Blue button style
  danger?: boolean;   // Red button style (for destructive actions)
}

export interface OverlayConfig {
  id: string;
  title: string;           // e.g., "Bug #1" or "Testing Bug #1"
  description: string;     // The issue description
  instructions?: string;   // Additional context text
  buttons: OverlayButton[];
  showComment?: boolean;   // Show comment textarea
  commentPlaceholder?: string;
}

export interface OverlayResult {
  action: OverlayAction;
  comment?: string;
}

// =============================================================================
// Preset Configurations
// =============================================================================

/**
 * Overlay for workOn when there's no sequence - offers Record or Explore
 */
export function getWorkOnNoSequenceConfig(
  issueType: 'bug' | 'feature',
  issueId: number,
  issueTitle: string
): OverlayConfig {
  const typeLabel = issueType === 'bug' ? 'Bug' : 'Feature';
  const actionLabel = issueType === 'bug' ? 'Reproduce' : 'Test';

  return {
    id: '__cdp-workon-overlay',
    title: `${typeLabel} #${issueId}`,
    description: issueTitle,
    instructions: 'No recording exists for this issue. Choose how to proceed:',
    buttons: [
      { id: 'cancel', label: 'CANCEL', action: 'cancel' },
      { id: 'explore', label: 'EXPLORE', action: 'explore' },
      { id: 'record', label: `${actionLabel.toUpperCase()} & RECORD`, action: 'record', primary: true },
    ],
  };
}

/**
 * Overlay for workOn/resolve when there IS a sequence - just Begin or Cancel
 */
export function getTestReadyConfig(
  issueType: 'bug' | 'feature',
  issueId: number,
  issueTitle: string
): OverlayConfig {
  const typeLabel = issueType === 'bug' ? 'Bug' : 'Feature';

  return {
    id: '__cdp-test-ready-overlay',
    title: `Testing ${typeLabel} #${issueId}`,
    description: issueTitle,
    instructions: 'The recorded sequence will replay. Watch for the issue.',
    buttons: [
      { id: 'cancel', label: 'CANCEL', action: 'cancel' },
      { id: 'begin', label: 'BEGIN TEST', action: 'begin', primary: true },
    ],
  };
}

/**
 * Overlay for resolve verification - asks if issue is fixed
 */
export function getVerificationConfig(
  issueType: 'bug' | 'feature',
  issueId: number,
  issueTitle: string
): OverlayConfig {
  const typeLabel = issueType === 'bug' ? 'Bug' : 'Feature';
  const questionText = issueType === 'bug'
    ? 'Is this bug fixed?'
    : 'Is this feature implemented?';
  const yesLabel = issueType === 'bug' ? 'FIXED' : 'IMPLEMENTED';
  const noLabel = issueType === 'bug' ? 'NOT FIXED' : 'NOT DONE';

  return {
    id: '__cdp-verification-overlay',
    title: `${typeLabel} #${issueId}`,
    description: issueTitle,
    instructions: questionText,
    buttons: [
      { id: 'no', label: noLabel, action: 'no' },
      { id: 'yes', label: yesLabel, action: 'yes', primary: true },
    ],
    showComment: true,
    commentPlaceholder: 'Add a comment (optional)',
  };
}

// =============================================================================
// Main Overlay Function
// =============================================================================

/**
 * Show a modal overlay with configurable buttons
 * Returns the action taken and optional comment
 */
export async function showOverlay(
  page: Page,
  config: OverlayConfig
): Promise<OverlayResult> {
  return await page.evaluate((params: OverlayConfig) => {
    return new Promise<OverlayResult>((resolve) => {
      const doc = (globalThis as any).document;

      // Remove any existing overlays that might interfere
      const existing = doc.getElementById(params.id);
      if (existing) existing.remove();
      const replayOverlay = doc.getElementById('__cdp-replay-overlay');
      if (replayOverlay) replayOverlay.remove();
      const verifyOverlay = doc.getElementById('__cdp-verification-overlay');
      if (verifyOverlay) verifyOverlay.remove();
      const testReadyOverlay = doc.getElementById('__cdp-test-ready-overlay');
      if (testReadyOverlay) testReadyOverlay.remove();

      // Clean up any replay overlay event listeners/styles
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
      overlay.id = params.id;
      // Reset all inherited styles and set our own
      overlay.style.cssText = 'all: initial; opacity: 1 !important;';

      const backdrop = doc.createElement('div');
      backdrop.style.cssText = `
        all: initial;
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

      // Title label
      const titleLabel = doc.createElement('div');
      titleLabel.textContent = params.title;
      titleLabel.style.cssText = `
        font-size: 12px !important;
        color: #757575 !important;
        text-transform: uppercase !important;
        letter-spacing: 0.5px !important;
        margin-bottom: 16px !important;
        opacity: 1 !important;
      `;

      // Description
      const description = doc.createElement('div');
      description.textContent = params.description;
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

      // Instructions (if provided)
      let instructionsEl: any = null;
      if (params.instructions) {
        instructionsEl = doc.createElement('div');
        instructionsEl.textContent = params.instructions;
        instructionsEl.style.cssText = `
          font-size: 14px !important;
          color: #616161 !important;
          margin-bottom: 24px !important;
          opacity: 1 !important;
        `;
      }

      // Comment textarea (if enabled)
      let commentInput: any = null;
      if (params.showComment) {
        commentInput = doc.createElement('textarea');
        commentInput.placeholder = params.commentPlaceholder || 'Add a comment (optional)';
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
      }

      // Button container
      const buttonContainer = doc.createElement('div');
      buttonContainer.style.cssText = `
        display: flex !important;
        gap: 8px !important;
        justify-content: center !important;
        flex-wrap: wrap !important;
        opacity: 1 !important;
      `;

      // Shared button styles
      const buttonBase = {
        minWidth: '120px',
        height: '36px',
        padding: '0 16px',
        borderRadius: '4px',
        border: 'none',
        fontSize: '14px',
        fontWeight: '500',
        cursor: 'pointer',
        textTransform: 'uppercase',
        letterSpacing: '0.5px'
      };

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

      // Create buttons
      for (const btnConfig of params.buttons) {
        const btn = doc.createElement('button');
        btn.id = `__cdp-overlay-${btnConfig.id}`;
        btn.textContent = btnConfig.label;

        let bgColor = '#f5f5f5';
        let textColor = '#616161';

        if (btnConfig.primary) {
          bgColor = '#1976d2';
          textColor = '#ffffff';
        } else if (btnConfig.danger) {
          bgColor = '#d32f2f';
          textColor = '#ffffff';
        }

        Object.assign(btn.style, {
          ...buttonBase,
          background: bgColor,
          color: textColor
        });

        btn.addEventListener('click', () => {
          const comment = commentInput?.value?.trim() || undefined;
          cleanup();
          resolve({ action: btnConfig.action, comment });
        });

        buttonContainer.appendChild(btn);
      }

      // Assemble card
      card.appendChild(titleLabel);
      card.appendChild(description);
      if (instructionsEl) card.appendChild(instructionsEl);
      if (commentInput) card.appendChild(commentInput);
      card.appendChild(buttonContainer);
      backdrop.appendChild(card);
      overlay.appendChild(backdrop);
      doc.body.appendChild(overlay);
    });
  }, config);
}

// =============================================================================
// Replay Overlay (non-blocking banner)
// =============================================================================

/**
 * Show a "Replay in progress" overlay that blocks user interaction
 * Returns a cleanup function to remove the overlay
 */
export async function showReplayBanner(
  page: Page,
  issueType: 'bug' | 'feature',
  issueTitle: string,
  issueId: number
): Promise<() => Promise<void>> {
  const typeLabel = issueType === 'bug' ? 'Bug' : 'Feature';

  await page.evaluate((params: {
    typeLabel: string;
    issueTitle: string;
    issueId: number;
  }) => {
    const doc = (globalThis as any).document;

    // Create overlay - transparent with banner at top
    // pointerEvents: 'none' allows automated clicks to pass through while
    // event listeners still capture and block manual user interactions
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
      pointerEvents: 'none',
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

    // Add keyframe animations
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

    const feedbackEvents = ['click', 'keydown', 'touchend'];
    const silentBlockEvents = ['mousedown', 'mouseup', 'keyup', 'keypress', 'touchstart'];

    const blockWithFeedback = (e: any) => {
      // Don't block if CDP replay is in progress (flag set by replay executor)
      if ((globalThis as any).__cdpReplayClickInProgress) return;

      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      attemptCount++;

      console.log('[devharness] Blocked user interaction during replay:', e.type, 'target:', e.target?.tagName);

      instructions.style.animation = 'none';
      void (instructions as any).offsetWidth;
      instructions.style.animation = 'cdp-shake 0.3s ease';

      if (attemptCount > 3) {
        const msgIndex = Math.min(attemptCount - 4, attitudeMessages.length - 1);
        instructions.textContent = attitudeMessages[msgIndex];
        instructions.style.color = '#d32f2f';
      }
    };

    const blockSilently = (e: any) => {
      // Don't block if CDP replay is in progress (flag set by replay executor)
      if ((globalThis as any).__cdpReplayClickInProgress) return;

      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };

    feedbackEvents.forEach(evt => doc.addEventListener(evt, blockWithFeedback, true));
    silentBlockEvents.forEach(evt => doc.addEventListener(evt, blockSilently, true));
    (globalThis as any).__cdpReplayBlocker = {
      blockWithFeedback,
      blockSilently,
      feedbackEvents,
      silentBlockEvents
    };
  }, { typeLabel, issueTitle, issueId });

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
    });
  };
}
