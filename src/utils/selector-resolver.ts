/**
 * Extended Selector Resolver
 *
 * Supports Playwright-style extended selectors that aren't native CSS:
 * - :has-text("text") - matches elements containing text (case-insensitive partial match)
 * - :text("text") - matches elements with exact text content
 * - :text-is("text") - alias for :text()
 *
 * Text matching includes: textContent, aria-label, and title attributes.
 *
 * Examples:
 *   button:has-text("Submit")      -> finds <button>Submit Form</button>
 *   a:has-text("Login")            -> finds <a href="/login">Login</a>
 *   a:has-text("Homepage")         -> finds <a aria-label="Homepage">...</a>
 *   div:text("Exact Match")        -> finds <div>Exact Match</div> (exact only)
 *   :has-text("Search")            -> finds any element containing "Search"
 */

export interface ResolvedSelector {
  /** The resolved CSS selector that can be used with querySelector */
  selector: string;
  /** Number of elements that matched */
  matchCount: number;
  /** Warning message if multiple matches found */
  warning?: string;
}

export interface SelectorError {
  error: string;
  originalSelector: string;
  suggestion?: string;
}

/**
 * Parse extended selector syntax and extract components
 */
function parseExtendedSelector(selector: string): {
  baseSelector: string;
  textMatch: { type: 'has-text' | 'text' | 'text-is'; value: string } | null;
} | { error: string } {
  // Check if this looks like an extended selector
  const extendedMatch = selector.match(/:(?:has-text|text|text-is)\(/);
  if (!extendedMatch) {
    return { baseSelector: selector, textMatch: null };
  }

  // Find the pseudo-class start position
  const pseudoStart = extendedMatch.index!;
  const beforePart = selector.substring(0, pseudoStart);

  // Extract the type (has-text, text, or text-is)
  const typeMatch = selector.substring(pseudoStart).match(/^:(has-text|text|text-is)\(/);
  if (!typeMatch) {
    return { error: 'Invalid extended selector syntax' };
  }

  const matchType = typeMatch[1] as 'has-text' | 'text' | 'text-is';
  const afterTypeStart = pseudoStart + typeMatch[0].length;

  // Parse the quoted string - handle both single and double quotes
  const remaining = selector.substring(afterTypeStart);
  const quoteChar = remaining[0];

  if (quoteChar !== '"' && quoteChar !== "'") {
    return { error: `Expected quote after :${matchType}(, got: ${quoteChar || 'end of string'}` };
  }

  // Find the closing quote, handling escaped quotes
  let textValue = '';
  let i = 1;
  while (i < remaining.length) {
    const char = remaining[i];
    if (char === '\\' && i + 1 < remaining.length) {
      // Escaped character - include the next char literally
      textValue += remaining[i + 1];
      i += 2;
    } else if (char === quoteChar) {
      // Found closing quote
      break;
    } else {
      textValue += char;
      i++;
    }
  }

  if (i >= remaining.length || remaining[i] !== quoteChar) {
    return { error: `Unterminated string in :${matchType}() selector` };
  }

  // Check for closing paren
  if (remaining[i + 1] !== ')') {
    return { error: `Expected ) after closing quote in :${matchType}() selector` };
  }

  // Get any remaining selector after the extended part
  const afterPart = remaining.substring(i + 2);

  // Combine before and after parts
  let baseSelector = (beforePart + afterPart).trim();
  if (!baseSelector) {
    baseSelector = '*';
  }

  return {
    baseSelector,
    textMatch: { type: matchType, value: textValue },
  };
}

/**
 * Check if a selector uses extended syntax
 */
export function isExtendedSelector(selector: string): boolean {
  return /:(?:has-text|text|text-is)\(/.test(selector);
}

/**
 * Resolve an extended selector to a standard CSS selector
 *
 * For extended selectors, this finds matching elements and returns a
 * data-attribute based selector that uniquely identifies the first match.
 *
 * @param page - Puppeteer page instance
 * @param selector - The selector (may include extended syntax like :has-text())
 * @returns Resolved selector info or error
 */
export async function resolveSelector(
  page: any,
  selector: string
): Promise<ResolvedSelector | SelectorError> {
  // Check if it's an extended selector
  if (!isExtendedSelector(selector)) {
    // Standard CSS selector - return as-is, let caller validate
    return {
      selector,
      matchCount: 1,
    };
  }

  const parsed = parseExtendedSelector(selector);

  if ('error' in parsed) {
    return {
      error: parsed.error,
      originalSelector: selector,
      suggestion: 'Check the selector syntax. Format: element:has-text("text") or element:text("exact text")',
    };
  }

  const { baseSelector, textMatch } = parsed;

  if (!textMatch) {
    // Shouldn't happen since we checked isExtendedSelector, but handle it
    return { selector, matchCount: 1 };
  }

  // Find matching elements and mark the first one with a unique attribute
  const result = await page.evaluate(
    (base: string, matchType: string, matchText: string) => {
      const elements = (globalThis as any).document.querySelectorAll(base);
      const matches: Array<{ text: string; tagName: string }> = [];
      let firstMatchElement: any = null;

      elements.forEach((el: any) => {
        const textContent = el.textContent?.trim() || '';
        const ariaLabel = el.getAttribute('aria-label') || '';
        const title = el.getAttribute('title') || '';
        // Combine all text sources for matching
        const allText = [textContent, ariaLabel, title].filter(Boolean).join(' ');
        let isMatch = false;

        if (matchType === 'has-text') {
          isMatch = allText.toLowerCase().includes(matchText.toLowerCase());
        } else {
          // 'text' or 'text-is' - exact match (check each source separately)
          isMatch = textContent === matchText || ariaLabel === matchText || title === matchText;
        }

        if (isMatch) {
          if (!firstMatchElement) {
            firstMatchElement = el;
          }
          const displayText = textContent || ariaLabel || title;
          matches.push({
            text: displayText.substring(0, 60) + (displayText.length > 60 ? '...' : ''),
            tagName: el.tagName.toLowerCase(),
          });
        }
      });

      if (matches.length === 0) {
        return { error: 'no_match' };
      }

      // Mark the first matching element with a unique data attribute
      const uniqueId = `cdp-ext-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
      firstMatchElement!.setAttribute('data-cdp-selector-match', uniqueId);

      return {
        uniqueId,
        matchCount: matches.length,
        matches: matches.slice(0, 5), // Return first 5 for context
        tagName: matches[0].tagName,
      };
    },
    baseSelector,
    textMatch.type,
    textMatch.value
  );

  if ('error' in result && result.error === 'no_match') {
    return {
      error: `Element not found: \`${selector}\``,
      originalSelector: selector,
      suggestion: `No ${baseSelector === '*' ? 'element' : `\`${baseSelector}\``} contains text "${textMatch.value}". Use \`content({ action: 'findInteractive', search: '${textMatch.value}' })\` to see available elements.`,
    };
  }

  // Build response
  const resolvedSelector = `[data-cdp-selector-match="${result.uniqueId}"]`;

  let warning: string | undefined;
  if (result.matchCount > 1) {
    const othersText = result.matches.slice(1).map((m: any) => `"${m.text}"`).join(', ');
    warning = `Found ${result.matchCount} matches. Using first match. Other matches: ${othersText}${result.matchCount > 5 ? ` (and ${result.matchCount - 5} more)` : ''}`;
  }

  return {
    selector: resolvedSelector,
    matchCount: result.matchCount,
    warning,
  };
}

/**
 * Clean up the temporary data attribute after use
 * Should be called after the selector has been used
 */
export async function cleanupResolvedSelector(page: any, selector: string): Promise<void> {
  if (!selector.startsWith('[data-cdp-selector-match=')) {
    return;
  }

  await page.evaluate((sel: string) => {
    const el = (globalThis as any).document.querySelector(sel);
    if (el) {
      el.removeAttribute('data-cdp-selector-match');
    }
  }, selector);
}
