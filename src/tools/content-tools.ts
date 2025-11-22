/**
 * Content Extraction Tools
 */

import { z } from 'zod';
import type { CDPManager } from '../cdp-manager.js';
import { PuppeteerManager } from '../puppeteer-manager.js';
import type { ConnectionManager } from '../connection-manager.js';
import { executeWithPauseDetection } from '../debugger-aware-wrapper.js';
import { checkBrowserAutomation } from '../error-helpers.js';
import { createTool } from '../validation-helpers.js';
import { getConfiguredDebugPort } from '../port-config.js';
import { createSuccessResponse, createErrorResponse } from '../messages.js';
import { promises as fs } from 'fs';
import path from 'path';
import type { ClickableCache, ClickableElement } from '../clickable-cache.js';

// All element types for findInteractive
const elementTypes = ['link', 'button', 'text', 'email', 'password', 'number', 'tel', 'url', 'search', 'textarea', 'select', 'checkbox', 'radio', 'file', 'date', 'other'] as const;

const contentSchema = z.object({
  action: z.enum(['extractText', 'findInteractive']).describe('Content action: extractText (extract webpage text), findInteractive (find all interactive elements like links, buttons, inputs)'),
  connectionReason: z.string().describe('Connection reference (use the reference from launchChrome output, e.g., "unnamed-connection-default" or your renamed tab)'),

  // extractText parameters
  mode: z.enum(['outline', 'full', 'section']).optional().describe('Mode: outline (metadata only), full (entire page), section (specific section by heading) - for extractText action'),
  section: z.string().optional().describe('Section heading (for extractText with mode=section)'),
  save: z.boolean().optional().describe('Save extracted text to disk (.claude/extracts/) - for extractText action'),

  // findInteractive parameters
  types: z.array(z.enum(elementTypes)).optional().describe('Filter by element types (for findInteractive action)'),
  showHidden: z.boolean().optional().describe('Include hidden elements (for findInteractive action, default: false)'),

  // Shared parameters
  search: z.string().optional().describe('Search term to filter results (for extractText, findInteractive actions)'),
  limit: z.number().optional().describe('Max results to return (for findInteractive action, default: 50)'),
}).strict();

export function createContentTools(puppeteerManager: PuppeteerManager, cdpManager: CDPManager, connectionManager: ConnectionManager, resolveConnectionFromReason: (connectionReason: string) => Promise<any>, clickableCache: ClickableCache) {
  /**
   * Save extracted content to disk
   */
  const saveExtractedContent = async (content: string, url: string): Promise<string> => {
    const timestamp = Date.now();
    const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const extractDir = path.join(process.cwd(), '.claude', 'extracts', date);

    // Ensure directory exists
    await fs.mkdir(extractDir, { recursive: true });

    // Create filename from URL (sanitize)
    const urlPart = url.replace(/[^a-z0-9]/gi, '-').substring(0, 50);
    const filename = `extract-${urlPart}-${timestamp}.md`;
    const filepath = path.join(extractDir, filename);

    await fs.writeFile(filepath, content);
    return filepath;
  };

  /**
   * Collect interactive elements from page (live, not cached)
   */
  const collectInteractiveElements = async (page: any): Promise<ClickableElement[]> => {
    const elements = await page.evaluate(() => {
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

        // 3. Try href for links
        if (tag === 'a' && el.href) {
          const href = el.getAttribute('href');
          if (href && href !== '#' && !href.startsWith('javascript:')) {
            return `a[href="${href}"]`;
          }
        }

        // 4. Try text-based selector using :has-text() (Puppeteer extension)
        const text = el.textContent?.trim();
        if (text && text.length > 0 && text.length <= 30) {
          const escapedText = text.replace(/"/g, '\\"');
          return `${tag}:has-text("${escapedText}")`;
        }

        // 5. Fall back to class-based selector
        if (el.className && typeof el.className === 'string') {
          const classes = el.className.split(' ').filter((c: string) => c.length > 0);
          if (classes.length > 0) {
            return `${tag}.${classes.join('.')}`;
          }
        }

        // 6. Last resort: just the tag
        return tag;
      };

      // Find all links
      // @ts-ignore
      document.querySelectorAll('a[href]').forEach((el: any) => {
        // @ts-ignore
        const style = window.getComputedStyle(el);
        if (style.display !== 'none' && style.visibility !== 'hidden') {
          const rect = el.getBoundingClientRect();
          const inViewport = rect.top >= 0 && rect.left >= 0 &&
                           rect.bottom <= viewportHeight && rect.right <= viewportWidth;
          results.push({
            type: 'link',
            text: el.textContent?.trim() || '',
            href: el.href,
            selector: getUniqueSelector(el, 'a'),
            inViewport,
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
        // @ts-ignore
        const style = window.getComputedStyle(el);
        if (style.display !== 'none' && style.visibility !== 'hidden') {
          const rect = el.getBoundingClientRect();
          const inViewport = rect.top >= 0 && rect.left >= 0 &&
                           rect.bottom <= viewportHeight && rect.right <= viewportWidth;
          results.push({
            type: 'button',
            text: el.textContent?.trim() || el.value || '',
            href: '',
            selector: getUniqueSelector(el, 'button'),
            inViewport,
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
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            label,
            required: el.required || false,
          });
        }
      });

      return results;
    });

    return elements;
  };

  return {
    content: createTool(
      'Inspect and extract content from webpages. Actions: extractText (extract webpage text with outline/full/section modes), findInteractive (find all interactive elements like links, buttons, inputs with summary or filtered view)',
      contentSchema,
      async (args) => {
        const { action } = args;

        // Resolve connection from reason
        const resolved = await resolveConnectionFromReason(args.connectionReason);
        if (!resolved) {
          return createErrorResponse('CONNECTION_NOT_FOUND', {
            message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
          });
        }

        const targetPuppeteerManager = resolved.puppeteerManager || puppeteerManager;
        const targetCdpManager = resolved.cdpManager;

        const error = checkBrowserAutomation(targetCdpManager, targetPuppeteerManager, action, getConfiguredDebugPort(), true);
        if (error) {
          return error;
        }

        const page = targetPuppeteerManager.getPage();

        switch (action) {
          case 'extractText': {
            const mode = args.mode || 'outline';

            const result = await executeWithPauseDetection(
              targetCdpManager,
              async () => {
                // Extract content structure and metadata
                const data = await page.evaluate(() => {
                  // @ts-ignore - This code runs in browser context

                  // Find main content area
                  const mainSelectors = ['main', 'article', '[role="main"]', '#main', '#content', '.main-content', '.article-content', '.post-content'];
                  // @ts-ignore
                  let mainElement: any = null;
                  for (const selector of mainSelectors) {
                    // @ts-ignore
                    mainElement = document.querySelector(selector);
                    if (mainElement) break;
                  }
                  if (!mainElement) {
                    // @ts-ignore
                    mainElement = document.body;
                  }

                  // Extract all headings with their text content for outline
                  const headings: { level: number; text: string; }[] = [];
                  // @ts-ignore
                  const headingElements = mainElement.querySelectorAll('h1, h2, h3, h4, h5, h6');
                  headingElements.forEach((h: any) => {
                    const level = parseInt(h.tagName[1]);
                    const text = h.textContent?.trim() || '';
                    if (text) {
                      headings.push({ level, text });
                    }
                  });

                  // Helper to convert HTML to markdown
                  const htmlToMarkdown = (element: any): string => {
                    const tag = element.tagName.toLowerCase();
                    const text = element.textContent?.trim() || '';

                    // Skip script, style, and hidden elements
                    if (tag === 'script' || tag === 'style' || tag === 'noscript') return '';
                    // @ts-ignore
                    const style = window.getComputedStyle(element);
                    if (style.display === 'none' || style.visibility === 'hidden') return '';

                    // Convert based on tag
                    switch (tag) {
                      case 'h1': return text ? `# ${text}\n\n` : '';
                      case 'h2': return text ? `## ${text}\n\n` : '';
                      case 'h3': return text ? `### ${text}\n\n` : '';
                      case 'h4': return text ? `#### ${text}\n\n` : '';
                      case 'h5': return text ? `##### ${text}\n\n` : '';
                      case 'h6': return text ? `###### ${text}\n\n` : '';
                      case 'p': return text ? `${text}\n\n` : '';
                      case 'a':
                        const href = element.getAttribute('href');
                        return href && text ? `[${text}](${href})` : text;
                      case 'strong':
                      case 'b': return text ? `**${text}**` : '';
                      case 'em':
                      case 'i': return text ? `*${text}*` : '';
                      case 'code': return text ? `\`${text}\`` : '';
                      case 'pre': return text ? `\`\`\`\n${text}\n\`\`\`\n\n` : '';
                      case 'blockquote': return text ? text.split('\n').map((l: string) => `> ${l}`).join('\n') + '\n\n' : '';
                      case 'li': return text ? `- ${text}\n` : '';
                      case 'ul':
                      case 'ol':
                        let listContent = '';
                        for (const child of Array.from(element.children)) {
                          listContent += htmlToMarkdown(child);
                        }
                        return listContent ? listContent + '\n' : '';
                      case 'br': return '\n';
                      case 'hr': return '---\n\n';
                      default:
                        if (element.children.length > 0) {
                          let childContent = '';
                          for (const child of Array.from(element.children)) {
                            childContent += htmlToMarkdown(child);
                          }
                          return childContent;
                        }
                        return text ? text + ' ' : '';
                    }
                  };

                  // Extract full markdown content
                  const markdown = htmlToMarkdown(mainElement).replace(/\n{3,}/g, '\n\n').replace(/ {2,}/g, ' ').trim();

                  return {
                    headings,
                    markdown,
                  };
                });

                const url = page.url();
                const title = await page.title();
                const wordCount = data.markdown.split(/\s+/).length;

                return {
                  url,
                  title,
                  headings: data.headings,
                  markdown: data.markdown,
                  wordCount,
                };
              },
              'extractText'
            );

            if (!result.result) {
              return createErrorResponse('EXTRACTION_FAILED');
            }

            const { url, title, headings, markdown, wordCount } = result.result;

            // Mode: outline (default) - return metadata and structure
            if (mode === 'outline') {
              // Apply search filter if provided
              let filteredHeadings = headings;
              if (args.search) {
                const searchLower = args.search.toLowerCase();
                filteredHeadings = headings.filter((h: any) => h.text.toLowerCase().includes(searchLower));
              }

              const outlineText = filteredHeadings.map((h: any) => '  '.repeat(h.level - 1) + `${h.level}. ${h.text}`).join('\n');

              // Estimate tokens (rough: ~4 chars per token)
              const estimatedTokens = Math.ceil(markdown.length / 4);

              let response = `# Content Outline: ${title}\n\n`;
              response += `**URL:** ${url}\n`;
              response += `**Total Sections:** ${headings.length}\n`;
              response += `**Total Words:** ${wordCount}\n`;
              response += `**Estimated Tokens:** ${estimatedTokens.toLocaleString()}\n`;
              response += `**Estimated Read Time:** ${Math.ceil(wordCount / 200)} minutes\n\n`;

              if (args.search) {
                response += `**Filtered by:** "${args.search}" (${filteredHeadings.length} matches)\n\n`;
              }

              // Add table of contents with clickable links
              response += `## Table of Contents\n\n`;
              filteredHeadings.forEach((h: any, i: number) => {
                const indent = '  '.repeat(h.level - 1);
                response += `${indent}${i + 1}. [${h.text}](#)\n`;
              });
              response += `\n`;

              response += `## Structure\n\n${outlineText}\n\n`;
              response += `---\n\n`;
              response += `**Next Steps:**\n`;
              response += `- Extract full content: \`content({ action: 'extractText', mode: 'full' })\`\n`;
              response += `- Extract specific section: \`content({ action: 'extractText', mode: 'section', section: 'Heading Name' })\`\n`;
              response += `- Search sections: \`content({ action: 'extractText', search: 'keyword' })\`\n`;
              response += `- Save to disk: \`content({ action: 'extractText', mode: 'full', save: true })\``;

              return {
                content: [{ type: 'text', text: response }],
              };
            }

            // Mode: section - extract specific section
            if (mode === 'section') {
              if (!args.section) {
                return createErrorResponse('INVALID_PARAMS', { message: 'Section parameter required for mode=section' });
              }

              // Find the section in markdown
              const sectionRegex = new RegExp(`^#+ ${args.section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'mi');
              const match = markdown.match(sectionRegex);

              if (!match) {
                return createErrorResponse('SECTION_NOT_FOUND', { section: args.section });
              }

              // Extract content from this section until next heading of same or higher level
              const sectionStart = match.index!;
              const sectionLevel = match[0].match(/^#+/)?.[0].length || 1;
              const nextHeadingRegex = new RegExp(`\n#{1,${sectionLevel}} `, 'g');
              nextHeadingRegex.lastIndex = sectionStart + match[0].length;
              const nextMatch = nextHeadingRegex.exec(markdown);

              const sectionContent = markdown.substring(sectionStart, nextMatch ? nextMatch.index : undefined);
              const sectionWordCount = sectionContent.split(/\s+/).length;

              let response = `# ${title}\n\n**URL:** ${url}\n**Section:** ${args.section}\n**Words:** ${sectionWordCount}\n\n---\n\n${sectionContent}`;

              if (args.save) {
                const filepath = await saveExtractedContent(response, url);
                response += `\n\n---\n\n**Saved to:** ${filepath}`;
              }

              return {
                content: [{ type: 'text', text: response }],
              };
            }

            // Mode: full - return entire page content
            let response = `# ${title}\n\n**URL:** ${url}\n**Word Count:** ${wordCount}\n\n---\n\n${markdown}`;

            if (args.save) {
              const filepath = await saveExtractedContent(response, url);
              response += `\n\n---\n\n**Saved to:** ${filepath}`;
            }

            return {
              content: [{ type: 'text', text: response }],
            };
          }

          case 'findInteractive': {
            const limit = args.limit || 50;
            const url = page.url();
            const title = await page.title();

            // Try to get cached elements first
            const cached = clickableCache.get(url);
            let elements: ClickableElement[];
            let wasFromCache = false;

            if (cached) {
              elements = cached.elements;
              wasFromCache = true;
            } else {
              // Fall back to live extraction if not cached
              const result = await executeWithPauseDetection(
                targetCdpManager,
                async () => collectInteractiveElements(page),
                'findInteractive'
              );

              if (!result.result) {
                return createErrorResponse('EXTRACTION_FAILED');
              }

              elements = result.result as ClickableElement[];
            }

            // Count and filter hidden elements (width/height <= 0)
            const showHidden = args.showHidden || false;
            const hiddenCount = elements.filter((el) => (el.width ?? 0) <= 0 || (el.height ?? 0) <= 0).length;
            if (!showHidden) {
              elements = elements.filter((el) => (el.width ?? 0) > 0 && (el.height ?? 0) > 0);
            }

            const totalCount = elements.length;
            const hasSearch = !!args.search;
            const hasTypes = args.types && args.types.length > 0;

            // Summary mode: no search or types filter
            if (!hasSearch && !hasTypes) {
              // Group elements by type
              const elementsByType: Record<string, typeof elements> = {};
              elements.forEach((el) => {
                if (!elementsByType[el.type]) {
                  elementsByType[el.type] = [];
                }
                elementsByType[el.type].push(el);
              });

              let response = `# Interactive Elements: ${title}\n\n`;
              response += `URL: ${url}\n`;
              response += `Total: ${totalCount} elements`;
              if (hiddenCount > 0 && !showHidden) {
                response += ` (${hiddenCount} hidden)`;
              }
              if (wasFromCache) {
                response += ` (cached)`;
              }
              response += `\n\n`;

              // Sort types by count descending
              const sortedTypes = Object.entries(elementsByType).sort(([, a], [, b]) => b.length - a.length);

              for (const [type, typeElements] of sortedTypes) {
                response += `\n**${type}** (${typeElements.length})\n`;
                typeElements.forEach((el) => {
                  const hidden = (el.width ?? 0) <= 0 || (el.height ?? 0) <= 0 ? ' (hidden)' : '';
                  response += `${el.text || '(no text)'} [${el.selector}]${hidden}\n`;
                });
              }

              // Find a good example selector from the page
              const exampleElement = elements.find((el) => el.selector.startsWith('#') || el.selector.startsWith('[name='));
              const exampleSelector = exampleElement?.selector || elements[0]?.selector || '.selector';
              response += `\nExample: \`input({ action: 'click', selector: '${exampleSelector}' })\``;

              return {
                content: [{ type: 'text', text: response }],
              };
            }

            // Filtered mode: apply search and/or types filter
            let filteredElements = elements;

            // Apply type filter
            if (hasTypes) {
              filteredElements = filteredElements.filter((el) => args.types!.includes(el.type as any));
            }

            // Apply search filter
            if (hasSearch) {
              const searchLower = args.search!.toLowerCase();
              filteredElements = filteredElements.filter((el) =>
                el.text.toLowerCase().includes(searchLower) ||
                el.href.toLowerCase().includes(searchLower) ||
                (el.label && el.label.toLowerCase().includes(searchLower))
              );
            }

            // Apply limit
            const hasMore = filteredElements.length > limit;
            const displayElements = filteredElements.slice(0, limit);

            // Determine if we're showing input types (need extra columns)
            const inputTypes = ['text', 'email', 'password', 'number', 'tel', 'url', 'search', 'textarea', 'select', 'checkbox', 'radio', 'file', 'date', 'other'];
            const showingInputs = displayElements.some((el) => inputTypes.includes(el.type));

            // Build response header
            let response = '';
            if (hasSearch && hasTypes) {
              response = `# Search "${args.search}" in ${args.types!.join(', ')}\n\n`;
            } else if (hasSearch) {
              response = `# Search Results: "${args.search}"\n\n`;
            } else {
              response = `# ${args.types!.map(t => t.charAt(0).toUpperCase() + t.slice(1) + 's').join(', ')} (${filteredElements.length})\n\n`;
            }

            response += `Found ${filteredElements.length} matches\n\n`;

            // Compact pipe-delimited format
            if (showingInputs) {
              response += `type|text|selector|required\n`;
              displayElements.forEach((el) => {
                const required = el.required ? 'yes' : '';
                response += `${el.type}|${el.text || '(no text)'}|${el.selector}|${required}\n`;
              });
            } else {
              response += `type|text|selector\n`;
              displayElements.forEach((el) => {
                const href = el.href ? ` → ${el.href.substring(0, 40)}${el.href.length > 40 ? '...' : ''}` : '';
                response += `${el.type}|${el.text || '(no text)'}${href}|${el.selector}\n`;
              });
            }

            if (hasMore) {
              response += `\n---\n${filteredElements.length - limit} more elements not shown. Use \`limit: ${limit * 2}\` to see more.\n`;
            }

            return {
              content: [{ type: 'text', text: response }],
            };
          }

          default:
            return createErrorResponse('INVALID_ACTION', { action });
        }
      }
    ),
  };
}
