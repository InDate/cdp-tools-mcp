/**
 * Shared element collection logic for interactive elements
 * Used by both page-tools.ts (navigation caching) and content-tools.ts (findInteractive)
 */

import type { ClickableElement } from './clickable-cache.js';

export interface CollectionResult {
  elements: ClickableElement[];
  viewportHeight: number;
  viewportWidth: number;
}

/**
 * Collect all interactive elements from a page
 * Includes links, buttons, and form inputs with semantic context
 */
export async function collectInteractiveElements(page: any): Promise<CollectionResult> {
  const result = await page.evaluate(() => {
    // @ts-ignore - This code runs in browser context
    const results: any[] = [];
    // @ts-ignore - window is available in browser context
    const viewportHeight = window.innerHeight;
    // @ts-ignore - window is available in browser context
    const viewportWidth = window.innerWidth;

    // Helper to find associated label for an input
    const getLabel = (el: any): string => {
      if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
      if (el.id) {
        // @ts-ignore
        const label = document.querySelector(`label[for="${el.id}"]`);
        if (label) return label.textContent?.trim() || '';
      }
      let parent = el.parentElement;
      while (parent) {
        if (parent.tagName.toLowerCase() === 'label') {
          return parent.textContent?.trim() || '';
        }
        parent = parent.parentElement;
      }
      return '';
    };

    // Helper to generate a unique selector for an element
    const getUniqueSelector = (el: any, tag: string): string => {
      // 1. ID is always unique
      if (el.id) return `#${el.id}`;

      // 2. For inputs, use name attribute
      if (el.name && (tag === 'input' || tag === 'textarea' || tag === 'select')) {
        return `[name="${el.name}"]`;
      }

      // 3. aria-label is stable and descriptive
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel && ariaLabel.length <= 40) {
        return `${tag}[aria-label="${ariaLabel}"]`;
      }

      // 4. Try href for links (prefer short/relative hrefs)
      if (tag === 'a' && el.href) {
        const href = el.getAttribute('href');
        if (href && href !== '#' && !href.startsWith('javascript:') && href.length <= 60) {
          return `a[href="${href}"]`;
        }
      }

      // 5. Try text-based selector using :has-text() (Puppeteer extension)
      const text = el.textContent?.trim();
      if (text && text.length > 0 && text.length <= 30) {
        const escapedText = text.replace(/"/g, '\\"');
        return `${tag}:has-text("${escapedText}")`;
      }

      // 6. Fall back to class-based selector (prefer short, non-hash classes)
      if (el.className && typeof el.className === 'string') {
        const classes = el.className.split(' ').filter((c: string) => c.length > 0 && c.length <= 20 && !c.includes('__'));
        if (classes.length > 0) {
          return `${tag}.${classes.slice(0, 2).join('.')}`;
        }
      }

      // 7. Last resort: just the tag
      return tag;
    };

    // Helper to get semantic context (nav, main, footer, etc.)
    const getSemanticContext = (el: any): string => {
      let parent = el.parentElement;
      while (parent) {
        const tag = parent.tagName.toLowerCase();
        if (tag === 'nav') return 'nav';
        if (tag === 'main') return 'main';
        if (tag === 'footer') return 'footer';
        if (tag === 'header') return 'header';
        if (tag === 'aside') return 'aside';
        if (tag === 'form') return 'form';
        if (parent.getAttribute('role') === 'navigation') return 'nav';
        if (parent.getAttribute('role') === 'main') return 'main';
        if (parent.getAttribute('role') === 'contentinfo') return 'footer';
        if (parent.getAttribute('role') === 'banner') return 'header';
        parent = parent.parentElement;
      }
      return 'main';
    };

    // Find all links
    // @ts-ignore
    document.querySelectorAll('a[href]').forEach((el: any) => {
      // Skip aria-hidden elements
      if (el.getAttribute('aria-hidden') === 'true') return;
      // @ts-ignore
      const style = window.getComputedStyle(el);
      if (style.display !== 'none' && style.visibility !== 'hidden') {
        const rect = el.getBoundingClientRect();
        const inViewport = rect.top >= 0 && rect.left >= 0 &&
                         rect.bottom <= viewportHeight && rect.right <= viewportWidth;
        const text = el.textContent?.trim() || el.getAttribute('aria-label') || el.getAttribute('title') || '';
        results.push({
          type: 'link',
          text,
          href: el.href,
          selector: getUniqueSelector(el, 'a'),
          inViewport,
          context: getSemanticContext(el),
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        });
      }
    });

    // Find all buttons
    // @ts-ignore
    document.querySelectorAll('button, input[type="button"], input[type="submit"]').forEach((el: any) => {
      // Skip aria-hidden elements
      if (el.getAttribute('aria-hidden') === 'true') return;
      // @ts-ignore
      const style = window.getComputedStyle(el);
      if (style.display !== 'none' && style.visibility !== 'hidden') {
        const rect = el.getBoundingClientRect();
        const inViewport = rect.top >= 0 && rect.left >= 0 &&
                         rect.bottom <= viewportHeight && rect.right <= viewportWidth;
        const text = el.textContent?.trim() || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '';
        results.push({
          type: 'button',
          text,
          href: '',
          selector: getUniqueSelector(el, 'button'),
          inViewport,
          context: getSemanticContext(el),
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        });
      }
    });

    // Find all inputs
    // @ts-ignore
    document.querySelectorAll('input:not([type="button"]):not([type="submit"]), textarea, select').forEach((el: any) => {
      // Skip aria-hidden elements
      if (el.getAttribute('aria-hidden') === 'true') return;
      // @ts-ignore
      const style = window.getComputedStyle(el);
      if (style.display !== 'none' && style.visibility !== 'hidden') {
        const rect = el.getBoundingClientRect();
        const inViewport = rect.top >= 0 && rect.left >= 0 &&
                         rect.bottom <= viewportHeight && rect.right <= viewportWidth;

        const tag = el.tagName.toLowerCase();
        let type = 'other';
        if (tag === 'textarea') {
          type = 'textarea';
        } else if (tag === 'select') {
          type = 'select';
        } else if (tag === 'input') {
          const inputType = el.type?.toLowerCase() || 'text';
          if (['text', 'email', 'password', 'number', 'tel', 'url', 'search', 'checkbox', 'radio', 'file', 'date'].includes(inputType)) {
            type = inputType;
          }
        }

        const label = getLabel(el);
        results.push({
          type,
          text: label || el.placeholder || el.name || el.id || '',
          href: '',
          selector: getUniqueSelector(el, tag),
          inViewport,
          context: getSemanticContext(el),
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          label,
          required: el.required || false,
        });
      }
    });

    return { results, viewportHeight, viewportWidth };
  });

  return {
    elements: result.results as ClickableElement[],
    viewportHeight: result.viewportHeight,
    viewportWidth: result.viewportWidth,
  };
}
