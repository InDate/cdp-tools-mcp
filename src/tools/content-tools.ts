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
import { getConfiguredDebugPort } from '../index.js';
import { createSuccessResponse, createErrorResponse } from '../messages.js';
import { promises as fs } from 'fs';
import path from 'path';

const extractTextSchema = z.object({
  mode: z.enum(['outline', 'full', 'section']).optional().default('outline').describe('Mode: outline (metadata only), full (entire page), section (specific section by heading)'),
  section: z.string().optional().describe('Section heading to extract (only used when mode=section)'),
  search: z.string().optional().describe('Search term to filter sections by (case-insensitive)'),
  save: z.boolean().optional().default(false).describe('Save extracted text to disk (.claude/extracts/)'),
  connectionReason: z.string().describe('Brief reason for needing this browser connection (3 descriptive words recommended). Requires existing tab or connection.'),
}).strict();

const findClickableElementsSchema = z.object({
  search: z.string().optional().describe('Search term to filter clickable elements (searches in text and href)'),
  limit: z.number().optional().default(50).describe('Maximum number of results to return (default: 50)'),
  types: z.array(z.enum(['link', 'button', 'input'])).optional().describe('Filter by element types'),
  connectionReason: z.string().describe('Brief reason for needing this browser connection (3 descriptive words recommended). Requires existing tab or connection.'),
}).strict();

const findInputElementsSchema = z.object({
  search: z.string().optional().describe('Search term to filter input elements (searches in label, placeholder, name, id)'),
  limit: z.number().optional().default(50).describe('Maximum number of results to return (default: 50)'),
  types: z.array(z.enum(['text', 'email', 'password', 'number', 'tel', 'url', 'search', 'textarea', 'select', 'checkbox', 'radio', 'file', 'date', 'other'])).optional().describe('Filter by input types'),
  connectionReason: z.string().describe('Brief reason for needing this browser connection (3 descriptive words recommended). Requires existing tab or connection.'),
}).strict();

export function createContentTools(puppeteerManager: PuppeteerManager, cdpManager: CDPManager, connectionManager: ConnectionManager, resolveConnectionFromReason: (connectionReason: string) => Promise<any>) {
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

  return {
    extractText: createTool(
      'Extract text content from webpage with outline/full/section modes. Returns metadata and structure first, then extract selectively. Supports search and save to disk.',
      extractTextSchema,
      async (args) => {
        // Resolve connection from reason
        const resolved = await resolveConnectionFromReason(args.connectionReason);
        if (!resolved) {
          return createErrorResponse('CONNECTION_NOT_FOUND', {
            message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
          });
        }

        const targetPuppeteerManager = resolved.puppeteerManager || puppeteerManager;
        const targetCdpManager = resolved.cdpManager;

        const error = checkBrowserAutomation(targetCdpManager, targetPuppeteerManager, 'extractText', getConfiguredDebugPort(), true);
        if (error) {
          return error;
        }

        const page = targetPuppeteerManager.getPage();

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
        if (args.mode === 'outline') {
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
          response += `- Extract full content: \`extractText({ mode: 'full' })\`\n`;
          response += `- Extract specific section: \`extractText({ mode: 'section', section: 'Heading Name' })\`\n`;
          response += `- Search sections: \`extractText({ search: 'keyword' })\`\n`;
          response += `- Save to disk: \`extractText({ mode: 'full', save: true })\``;

          return {
            content: [{ type: 'text', text: response }],
          };
        }

        // Mode: section - extract specific section
        if (args.mode === 'section') {
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
    ),

    findClickableElements: createTool(
      'Find all clickable elements on the page (links, buttons, inputs). Returns total count with search/filter capability.',
      findClickableElementsSchema,
      async (args) => {
        // Resolve connection from reason
        const resolved = await resolveConnectionFromReason(args.connectionReason);
        if (!resolved) {
          return createErrorResponse('CONNECTION_NOT_FOUND', {
            message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
          });
        }

        const targetPuppeteerManager = resolved.puppeteerManager || puppeteerManager;
        const targetCdpManager = resolved.cdpManager;

        const error = checkBrowserAutomation(targetCdpManager, targetPuppeteerManager, 'findClickableElements', getConfiguredDebugPort(), true);
        if (error) {
          return error;
        }

        const page = targetPuppeteerManager.getPage();

        const result = await executeWithPauseDetection(
          targetCdpManager,
          async () => {
            const elements = await page.evaluate(() => {
              // @ts-ignore
              const results: any[] = [];

              // Find all links
              // @ts-ignore
              document.querySelectorAll('a[href]').forEach((el: any) => {
                // @ts-ignore
                const style = window.getComputedStyle(el);
                if (style.display !== 'none' && style.visibility !== 'hidden') {
                  results.push({
                    type: 'link',
                    text: el.textContent?.trim() || '',
                    href: el.href,
                    selector: el.id ? `#${el.id}` : el.className ? `.${el.className.split(' ')[0]}` : 'a',
                  });
                }
              });

              // Find all buttons
              // @ts-ignore
              document.querySelectorAll('button, input[type="button"], input[type="submit"]').forEach((el: any) => {
                // @ts-ignore
                const style = window.getComputedStyle(el);
                if (style.display !== 'none' && style.visibility !== 'hidden') {
                  results.push({
                    type: 'button',
                    text: el.textContent?.trim() || el.value || '',
                    href: '',
                    selector: el.id ? `#${el.id}` : el.className ? `.${el.className.split(' ')[0]}` : 'button',
                  });
                }
              });

              // Find all inputs
              // @ts-ignore
              document.querySelectorAll('input:not([type="button"]):not([type="submit"]), textarea, select').forEach((el: any) => {
                // @ts-ignore
                const style = window.getComputedStyle(el);
                if (style.display !== 'none' && style.visibility !== 'hidden') {
                  results.push({
                    type: 'input',
                    text: el.placeholder || el.name || el.id || '',
                    href: '',
                    selector: el.id ? `#${el.id}` : el.name ? `[name="${el.name}"]` : 'input',
                  });
                }
              });

              return results;
            });

            return elements;
          },
          'findClickableElements'
        );

        if (!result.result) {
          return createErrorResponse('EXTRACTION_FAILED');
        }

        let elements = result.result;
        const totalCount = elements.length;

        // Apply type filter
        if (args.types && args.types.length > 0) {
          elements = elements.filter((el: any) => args.types!.includes(el.type));
        }

        // Apply search filter
        if (args.search) {
          const searchLower = args.search.toLowerCase();
          elements = elements.filter((el: any) =>
            el.text.toLowerCase().includes(searchLower) ||
            el.href.toLowerCase().includes(searchLower)
          );
        }

        // Apply limit
        const hasMore = elements.length > args.limit!;
        const displayElements = elements.slice(0, args.limit!);

        // Format response
        const url = page.url();
        const title = await page.title();

        // Estimate tokens for all elements (rough: ~4 chars per token)
        const allText = elements.map((el: any) => `${el.text} ${el.href}`).join(' ');
        const estimatedTokens = Math.ceil(allText.length / 4);

        let response = `# Clickable Elements: ${title}\n\n`;
        response += `**URL:** ${url}\n`;
        response += `**Total Elements:** ${totalCount}\n`;

        if (args.types || args.search) {
          response += `**Filtered Results:** ${elements.length}\n`;
        }

        response += `**Showing:** ${displayElements.length}\n`;
        response += `**Estimated Tokens (all):** ${estimatedTokens.toLocaleString()}\n\n`;

        // Group by type
        const byType: any = { link: [], button: [], input: [] };
        displayElements.forEach((el: any) => {
          byType[el.type].push(el);
        });

        for (const type of ['link', 'button', 'input']) {
          if (byType[type].length > 0) {
            response += `## ${type.charAt(0).toUpperCase() + type.slice(1)}s (${byType[type].length})\n\n`;
            byType[type].forEach((el: any, i: number) => {
              const href = el.href ? ` → ${el.href}` : '';
              response += `${i + 1}. **${el.text || '(no text)'}**${href}\n   - Selector: \`${el.selector}\`\n`;
            });
            response += '\n';
          }
        }

        if (hasMore) {
          response += `\n---\n\n**Note:** ${elements.length - args.limit!} more elements not shown. Use \`limit\` parameter to see more.\n`;
        }

        response += `\n**Filter Options:**\n`;
        response += `- Search: \`findClickableElements({ search: 'keyword' })\`\n`;
        response += `- By type: \`findClickableElements({ types: ['link'] })\`\n`;
        response += `- Increase limit: \`findClickableElements({ limit: 100 })\``;

        return {
          content: [{ type: 'text', text: response }],
        };
      }
    ),

    findInputElements: createTool(
      'Find all input/form elements on the page (text fields, selects, checkboxes, etc.). Returns outline with total count, types breakdown, and search capability.',
      findInputElementsSchema,
      async (args) => {
        // Resolve connection from reason
        const resolved = await resolveConnectionFromReason(args.connectionReason);
        if (!resolved) {
          return createErrorResponse('CONNECTION_NOT_FOUND', {
            message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
          });
        }

        const targetPuppeteerManager = resolved.puppeteerManager || puppeteerManager;
        const targetCdpManager = resolved.cdpManager;

        const error = checkBrowserAutomation(targetCdpManager, targetPuppeteerManager, 'findInputElements', getConfiguredDebugPort(), true);
        if (error) {
          return error;
        }

        const page = targetPuppeteerManager.getPage();

        const result = await executeWithPauseDetection(
          targetCdpManager,
          async () => {
            const elements = await page.evaluate(() => {
              // @ts-ignore
              const results: any[] = [];

              // Find associated label for an input
              const getLabel = (el: any): string => {
                // Check for aria-label
                if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');

                // Check for associated label via for/id
                if (el.id) {
                  // @ts-ignore
                  const label = document.querySelector(`label[for="${el.id}"]`);
                  if (label) return label.textContent?.trim() || '';
                }

                // Check for parent label
                let parent = el.parentElement;
                while (parent) {
                  if (parent.tagName.toLowerCase() === 'label') {
                    return parent.textContent?.trim() || '';
                  }
                  parent = parent.parentElement;
                }

                return '';
              };

              // Process all input elements
              // @ts-ignore
              document.querySelectorAll('input, textarea, select').forEach((el: any) => {
                // @ts-ignore
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden') return;

                const tag = el.tagName.toLowerCase();
                let type = 'other';

                if (tag === 'textarea') {
                  type = 'textarea';
                } else if (tag === 'select') {
                  type = 'select';
                } else if (tag === 'input') {
                  const inputType = el.type?.toLowerCase() || 'text';
                  // Map common types
                  if (['text', 'email', 'password', 'number', 'tel', 'url', 'search', 'checkbox', 'radio', 'file', 'date'].includes(inputType)) {
                    type = inputType;
                  } else {
                    type = 'other';
                  }
                }

                const label = getLabel(el);
                const placeholder = el.placeholder || '';
                const name = el.name || '';
                const id = el.id || '';
                const value = el.value || '';
                const required = el.required || false;

                results.push({
                  type,
                  label,
                  placeholder,
                  name,
                  id,
                  value,
                  required,
                  selector: id ? `#${id}` : name ? `[name="${name}"]` : `${tag}`,
                });
              });

              return results;
            });

            return elements;
          },
          'findInputElements'
        );

        if (!result.result) {
          return createErrorResponse('EXTRACTION_FAILED');
        }

        let elements = result.result;
        const totalCount = elements.length;

        // Count by type for overview
        const typeCounts: any = {};
        elements.forEach((el: any) => {
          typeCounts[el.type] = (typeCounts[el.type] || 0) + 1;
        });

        // Apply type filter
        if (args.types && args.types.length > 0) {
          elements = elements.filter((el: any) => args.types!.includes(el.type));
        }

        // Apply search filter
        if (args.search) {
          const searchLower = args.search.toLowerCase();
          elements = elements.filter((el: any) =>
            el.label.toLowerCase().includes(searchLower) ||
            el.placeholder.toLowerCase().includes(searchLower) ||
            el.name.toLowerCase().includes(searchLower) ||
            el.id.toLowerCase().includes(searchLower)
          );
        }

        // Apply limit
        const hasMore = elements.length > args.limit!;
        const displayElements = elements.slice(0, args.limit!);

        // Estimate tokens
        const allText = elements.map((el: any) => `${el.label} ${el.placeholder} ${el.name} ${el.id}`).join(' ');
        const estimatedTokens = Math.ceil(allText.length / 4);

        // Format response
        const url = page.url();
        const title = await page.title();

        let response = `# Input Elements: ${title}\n\n`;
        response += `**URL:** ${url}\n`;
        response += `**Total Input Elements:** ${totalCount}\n`;

        // Show type breakdown
        response += `**Types Breakdown:**\n`;
        Object.entries(typeCounts).sort(([,a]: any, [,b]: any) => b - a).forEach(([type, count]) => {
          response += `  - ${type}: ${count}\n`;
        });
        response += `\n`;

        if (args.types || args.search) {
          response += `**Filtered Results:** ${elements.length}\n`;
        }

        response += `**Showing:** ${displayElements.length}\n`;
        response += `**Estimated Tokens (all):** ${estimatedTokens.toLocaleString()}\n\n`;

        // Group by type
        const byType: any = {};
        displayElements.forEach((el: any) => {
          if (!byType[el.type]) byType[el.type] = [];
          byType[el.type].push(el);
        });

        // Display elements grouped by type
        for (const [type, items] of Object.entries(byType)) {
          const itemList = items as any[];
          response += `## ${type.charAt(0).toUpperCase() + type.slice(1)} (${itemList.length})\n\n`;
          itemList.forEach((el: any, i: number) => {
            const displayName = el.label || el.placeholder || el.name || el.id || '(no label)';
            const requiredBadge = el.required ? ' **[Required]**' : '';
            response += `${i + 1}. **${displayName}**${requiredBadge}\n`;
            if (el.placeholder && el.placeholder !== displayName) {
              response += `   - Placeholder: "${el.placeholder}"\n`;
            }
            if (el.name) {
              response += `   - Name: \`${el.name}\`\n`;
            }
            response += `   - Selector: \`${el.selector}\`\n`;
          });
          response += '\n';
        }

        if (hasMore) {
          response += `\n---\n\n**Note:** ${elements.length - args.limit!} more elements not shown. Use \`limit\` parameter to see more.\n`;
        }

        response += `\n**Filter Options:**\n`;
        response += `- Search: \`findInputElements({ search: 'email' })\`\n`;
        response += `- By type: \`findInputElements({ types: ['text', 'email'] })\`\n`;
        response += `- Increase limit: \`findInputElements({ limit: 100 })\``;

        return {
          content: [{ type: 'text', text: response }],
        };
      }
    ),
  };
}
