/**
 * Selector coverage in a recording's summary.
 *
 * Counting events tells you how much was recorded; coverage tells you whether
 * the recording will still work after a re-render. A click captured as a
 * selector survives layout changes; one captured as bare coordinates does not,
 * and fails in the least obvious way - it clicks whatever now sits at that
 * position. These assertions pin the classification, not merely that the
 * fields exist.
 */

import { describe, it, expect } from 'vitest';
import { calculateSummary, type InputEvent } from './interaction-recorder.js';

const click = (elementInfo?: any): InputEvent => ({
  type: 'click', x: 10, y: 20, timestamp: 0, elementInfo,
} as InputEvent);

const key = (k: string): InputEvent => ({
  type: 'keydown', key: k, code: k, timestamp: 0,
} as InputEvent);

describe('recording summary - selector coverage', () => {
  it('counts a click with a selector as covered, and as interactive only when the element is', () => {
    const summary = calculateSummary([
      click({ selector: '#submit', isInteractive: true, tag: 'button' }),
      click({ selector: '.card', isInteractive: false, tag: 'div' }),
    ]);

    expect(summary.clicks).toBe(2);
    expect(summary.selectorsAvailable).toBe(2);
    expect(summary.interactiveElements).toBe(1);
    expect(summary.coordinatesOnly).toBe(0);
  });

  it('counts a click with no selector as coordinates-only - the brittle case', () => {
    const summary = calculateSummary([
      click({ tag: 'div' }),
      click(undefined),
    ]);

    expect(summary.coordinatesOnly).toBe(2);
    expect(summary.selectorsAvailable).toBe(0);
    expect(summary.canvasInteractions).toBe(0);
  });

  it('counts a canvas click as both canvas and coordinates-only', () => {
    // Canvas is coordinate-fragile by necessity rather than by failure to find
    // a selector, so it belongs in both counts: the caller needs to know the
    // click is position-dependent, and also that this one is expected to be.
    const summary = calculateSummary([click({ isCanvas: true, tag: 'canvas' })]);

    expect(summary.canvasInteractions).toBe(1);
    expect(summary.coordinatesOnly).toBe(1);
    expect(summary.selectorsAvailable).toBe(0);
  });

  it('separates typed characters from navigation and modifier keys', () => {
    const summary = calculateSummary([
      key('a'), key('b'), key('Enter'), key('Shift'), key('ArrowDown'),
    ]);

    expect(summary.keyPresses).toBe(5);
    expect(summary.typedCharacters).toBe(2);
  });

  it('reports full coverage for a wholly selector-based recording', () => {
    const summary = calculateSummary([
      click({ selector: '#a', isInteractive: true }),
      click({ selector: '#b', isInteractive: true }),
    ]);

    // coordinatesOnly === 0 is what suppresses the warning in the tool
    // response, so this is the case that must NOT produce one.
    expect(summary.coordinatesOnly).toBe(0);
    expect(summary.selectorsAvailable).toBe(summary.clicks);
  });

  it('leaves coverage at zero for a recording with no clicks', () => {
    const summary = calculateSummary([key('a')]);

    expect(summary.clicks).toBe(0);
    expect(summary.selectorsAvailable).toBe(0);
    expect(summary.coordinatesOnly).toBe(0);
  });
});
