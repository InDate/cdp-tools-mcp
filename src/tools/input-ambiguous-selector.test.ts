import { describe, it, expect } from 'vitest';
import { ambiguousSelectorWarning } from './input-tools.js';

/** Minimal page stand-in. `evaluate` is what the rest of input-tools uses, so the
 *  stub matches the real surface rather than a convenient one. */
const pageMatching = (count: number) => ({
  evaluate: async (_fn: (sel: string) => number, _selector: string) => count,
});

describe('ambiguousSelectorWarning', () => {
  it('says nothing when the selector matches exactly one element', async () => {
    await expect(ambiguousSelectorWarning(pageMatching(1), 'button', 'button')).resolves.toBeUndefined();
  });

  it('says nothing when the selector matches none — that is the action\'s own error', async () => {
    await expect(ambiguousSelectorWarning(pageMatching(0), 'button', 'button')).resolves.toBeUndefined();
  });

  it('reports the count and that the first was used', async () => {
    const warning = await ambiguousSelectorWarning(pageMatching(6), 'button', 'button[aria-label="Use"]');
    expect(warning).toContain('6');
    expect(warning).toMatch(/first/i);
  });

  it('quotes the RAW selector, not the resolved one', async () => {
    // :has-text() is rewritten before the action runs; echoing the rewritten
    // form back would show the caller a selector they never wrote.
    const warning = await ambiguousSelectorWarning(pageMatching(3), '.resolved-xyz', ':has-text("Use")');
    expect(warning).toContain(':has-text("Use")');
    expect(warning).not.toContain('.resolved-xyz');
  });

  it('stays quiet when the page cannot evaluate the selector', async () => {
    // An invalid selector is reported by the action itself; this helper must not
    // turn a counting failure into a spurious warning.
    const page = { evaluate: async () => { throw new Error('invalid selector'); } };
    await expect(ambiguousSelectorWarning(page, '((', '((')).resolves.toBeUndefined();
  });
});
