import { describe, it, expect } from 'vitest';
import { substituteCapturedValues, type CaptureEntry } from './interpolation-reverse.js';
import { interpolateParams } from './interpolation.js';

describe('substituteCapturedValues', () => {
  it('rewrites a whole-value literal that matches a captured value', () => {
    const captures: CaptureEntry[] = [
      { name: 'mint', value: { ok: true, status: 200, body: { url: 'https://app.test/mint/abc123def' } } },
    ];
    const params = { action: 'goto', url: 'https://app.test/mint/abc123def' };

    expect(substituteCapturedValues(params, captures)).toEqual({
      action: 'goto',
      url: '{{var:mint.body.url}}',
    });
  });

  it('rewrites a literal embedded inside a larger string (e.g. a CSS selector)', () => {
    const captures: CaptureEntry[] = [{ name: 'personId', value: 48213 }];
    const params = { selector: '[data-row-key="48213"]' };

    expect(substituteCapturedValues(params, captures)).toEqual({
      selector: '[data-row-key="{{var:personId}}"]',
    });
  });

  it('emits a bare {{var:name}} token when the capture itself is the leaf (no nesting)', () => {
    const captures: CaptureEntry[] = [{ name: 'personId', value: 48213 }];
    const params = { id: 48213 };

    expect(substituteCapturedValues(params, captures)).toEqual({ id: '{{var:personId}}' });
  });

  it('does not substitute a small/common number even if it exactly matches a capture', () => {
    const captures: CaptureEntry[] = [{ name: 'mint', value: { status: 200 } }];
    const params = { retryStatus: 200 };

    expect(substituteCapturedValues(params, captures)).toEqual({ retryStatus: 200 });
  });

  it('does not substitute booleans', () => {
    const captures: CaptureEntry[] = [{ name: 'mint', value: { ok: true } }];
    const params = { enabled: true };

    expect(substituteCapturedValues(params, captures)).toEqual({ enabled: true });
  });

  it('does not substitute a short embedded value below the length floor', () => {
    const captures: CaptureEntry[] = [{ name: 'code', value: 'ab' }];
    const params = { path: '/x/ab/y' };

    expect(substituteCapturedValues(params, captures)).toEqual({ path: '/x/ab/y' });
  });

  it('leaves unrelated literals untouched', () => {
    const captures: CaptureEntry[] = [{ name: 'mint', value: { body: { url: 'https://app.test/mint/abc123def' } } }];
    const params = { action: 'goto', url: 'https://app.test/other-page' };

    expect(substituteCapturedValues(params, captures)).toEqual(params);
  });

  it('walks arrays and nested objects', () => {
    const captures: CaptureEntry[] = [{ name: 'personId', value: 48213 }];
    const params = { rows: [{ id: 48213 }, { id: 999999 }] };

    expect(substituteCapturedValues(params, captures)).toEqual({
      rows: [{ id: '{{var:personId}}' }, { id: 999999 }],
    });
  });

  it('prefers the earliest capture on a value collision', () => {
    const captures: CaptureEntry[] = [
      { name: 'first', value: 'shared-value-123' },
      { name: 'second', value: 'shared-value-123' },
    ];
    const params = { x: 'shared-value-123' };

    expect(substituteCapturedValues(params, captures)).toEqual({ x: '{{var:first}}' });
  });

  it('is a no-op with no captures', () => {
    const params = { url: 'https://app.test/mint/abc123def' };
    expect(substituteCapturedValues(params, [])).toBe(params);
  });

  it('produces tokens that interpolateParams resolves back to the original value', () => {
    const captures: CaptureEntry[] = [
      { name: 'mint', value: { ok: true, status: 200, body: { url: 'https://app.test/mint/abc123def' } } },
    ];
    const params = { url: 'https://app.test/mint/abc123def' };
    const substituted = substituteCapturedValues(params, captures);

    const store = { mint: captures[0].value };
    expect(interpolateParams(substituted, store, 0).url).toBe('https://app.test/mint/abc123def');
  });
});
