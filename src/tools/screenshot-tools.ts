/**
 * Screenshot Tools
 */

import { z } from 'zod';
import type { CDPManager } from '../cdp-manager.js';
import { PuppeteerManager } from '../puppeteer-manager.js';
import type { ConnectionManager } from '../connection-manager.js';
import { executeWithPauseDetection, formatActionResult } from '../debugger-aware-wrapper.js';
import { checkBrowserAutomation } from '../error-helpers.js';
import { createTool } from '../validation-helpers.js';
import { getConfiguredDebugPort } from '../index.js';
import { promises as fs } from 'fs';
import path from 'path';
import { createSuccessResponse, createErrorResponse } from '../messages.js';
import { spawn } from 'child_process';

// WeasyPrint availability cache
let weasyPrintCache: { available: boolean; version?: string; error?: string; checkedAt: number } | null = null;
const CACHE_TTL = 60000; // 1 minute

/**
 * Check if WeasyPrint is installed and available
 */
async function checkWeasyPrintAvailable(): Promise<{ available: boolean; version?: string; error?: string }> {
  // Return cached result if fresh
  if (weasyPrintCache && (Date.now() - weasyPrintCache.checkedAt) < CACHE_TTL) {
    return { available: weasyPrintCache.available, version: weasyPrintCache.version, error: weasyPrintCache.error };
  }

  return new Promise((resolve) => {
    const process = spawn('weasyprint', ['--version']);

    let output = '';
    let errorOutput = '';
    let resolved = false;

    process.stdout.on('data', (data) => {
      output += data.toString();
    });

    process.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    process.on('close', (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutHandle);

      if (code === 0) {
        const version = output.trim() || errorOutput.trim(); // Version might be on stderr
        const result = { available: true, version };
        weasyPrintCache = { ...result, checkedAt: Date.now() };
        resolve(result);
      } else {
        const result = {
          available: false,
          error: 'WeasyPrint not found in PATH or failed to execute'
        };
        weasyPrintCache = { ...result, checkedAt: Date.now() };
        resolve(result);
      }
    });

    process.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutHandle);

      const result = {
        available: false,
        error: `Failed to execute weasyprint: ${err.message}`
      };
      weasyPrintCache = { ...result, checkedAt: Date.now() };
      resolve(result);
    });

    // Timeout after 5 seconds
    const timeoutHandle = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      process.kill();

      const result = {
        available: false,
        error: 'WeasyPrint check timed out'
      };
      weasyPrintCache = { ...result, checkedAt: Date.now() };
      resolve(result);
    }, 5000);
  });
}

export function createScreenshotTools(puppeteerManager: PuppeteerManager, cdpManager: CDPManager, connectionManager: ConnectionManager, resolveConnectionFromReason: (connectionReason: string) => Promise<any>) {
  /**
   * Save screenshot buffer to disk
   */
  const saveScreenshotToDisk = async (buffer: Buffer, type: string, suggestedPath?: string): Promise<string> => {
    const timestamp = Date.now();
    const ext = type === 'png' ? 'png' : 'jpg';

    // If user provided a path, use it
    if (suggestedPath) {
      const filepath = path.isAbsolute(suggestedPath) ? suggestedPath : path.join(process.cwd(), suggestedPath);
      await fs.writeFile(filepath, buffer);
      return filepath;
    }

    // Default: save to .claude/screenshots/YYYY-MM-DD/
    const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const screenshotDir = path.join(process.cwd(), '.claude', 'screenshots', date);

    // Ensure directory exists
    await fs.mkdir(screenshotDir, { recursive: true });

    const filename = `screenshot-${timestamp}.${ext}`;
    const filepath = path.join(screenshotDir, filename);

    await fs.writeFile(filepath, buffer);

    return filepath;
  };

  // Zod schemas for screenshot tools
  const clipSchema = z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  }).strict();

  const takeScreenshotSchema = z.object({
    fullPage: z.boolean().default(true),
    type: z.enum(['png', 'jpeg']).default('jpeg'),
    quality: z.number().min(0).max(100).optional(),
    clip: clipSchema.optional(),
    saveToDisk: z.string().optional(),
    autoSaveThreshold: z.number().default(1).describe('Auto-save to disk if size >= this (bytes). Default: 1 byte (always saves)'),
    connectionReason: z.string().describe('Brief reason for needing this browser connection (3 descriptive words recommended, e.g., \'search wikipedia results\', \'test checkout flow\'). Auto-creates/reuses tabs.'),
  }).strict();

  const takeViewportScreenshotSchema = z.object({
    type: z.enum(['png', 'jpeg']).default('jpeg'),
    quality: z.number().min(0).max(100).optional(),
    clip: clipSchema.optional(),
    saveToDisk: z.string().optional(),
    autoSaveThreshold: z.number().default(1).describe('Auto-save to disk if size >= this (bytes). Default: 1 byte (always saves)'),
    connectionReason: z.string().describe('Brief reason for needing this browser connection (3 descriptive words recommended, e.g., \'search wikipedia results\', \'test checkout flow\'). Auto-creates/reuses tabs.'),
  }).strict();

  const takeElementScreenshotSchema = z.object({
    selector: z.string(),
    type: z.enum(['png', 'jpeg']).default('jpeg'),
    quality: z.number().min(0).max(100).optional(),
    saveToDisk: z.string().optional(),
    autoSaveThreshold: z.number().default(1).describe('Auto-save to disk if size >= this (bytes). Default: 1 byte (always saves)'),
    connectionReason: z.string().describe('Brief reason for needing this browser connection (3 descriptive words recommended, e.g., \'search wikipedia results\', \'test checkout flow\'). Auto-creates/reuses tabs.'),
  }).strict();

  return {
    takeScreenshot: createTool(
      'Take a screenshot of the full page. Automatically saves to disk (default behavior) to avoid token limits. Returns file path. Default quality is 30 for JPEG.',
      takeScreenshotSchema,
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

        const error = checkBrowserAutomation(targetCdpManager, targetPuppeteerManager, 'takeScreenshot', getConfiguredDebugPort(), true);
        if (error) {
          return error;
        }

        const page = targetPuppeteerManager.getPage();
        const fullPage = args.fullPage;
        const type = args.type;
        const quality = args.quality ?? (args.clip ? 50 : 30);

        // Get screenshot as Buffer (not base64 yet)
        const screenshot = await page.screenshot({
          fullPage,
          type: type as 'png' | 'jpeg',
          ...(type === 'jpeg' && { quality }),
          ...(args.clip && { clip: args.clip }),
          optimizeForSpeed: true,
        }) as Buffer;

        // Check if we should save to disk
        const shouldSaveToDisk = screenshot.length >= args.autoSaveThreshold || args.saveToDisk;

        if (shouldSaveToDisk) {
          const filepath = await saveScreenshotToDisk(screenshot, type, args.saveToDisk);
          const sizeMB = (screenshot.length / 1_000_000).toFixed(2);
          const fileSize = `${sizeMB}MB`;
          return createSuccessResponse('SCREENSHOT_SAVED', { filepath, fileSize });
        }

        // Small screenshot: return as native image content
        return {
          content: [
            {
              type: 'text',
              text: `Screenshot captured (${(screenshot.length / 1000).toFixed(1)}KB)`,
            },
            {
              type: 'image',
              data: screenshot.toString('base64'),
              mimeType: `image/${type}`,
            },
          ],
        };
      }
    ),

    takeViewportScreenshot: createTool(
      'Take a screenshot of the current viewport. Automatically saves to disk (default behavior) to avoid token limits. Returns file path. Default quality is 30 for JPEG.',
      takeViewportScreenshotSchema,
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

        const error = checkBrowserAutomation(targetCdpManager, targetPuppeteerManager, 'takeViewportScreenshot', getConfiguredDebugPort(), true);
        if (error) {
          return error;
        }

        const page = targetPuppeteerManager.getPage();
        const type = args.type;
        const quality = args.quality ?? (args.clip ? 50 : 30);

        // Get screenshot as Buffer (not base64 yet)
        const screenshot = await page.screenshot({
          fullPage: false,
          type: type as 'png' | 'jpeg',
          ...(type === 'jpeg' && { quality }),
          ...(args.clip && { clip: args.clip }),
          optimizeForSpeed: true,
        }) as Buffer;

        // Check if we should save to disk
        const shouldSaveToDisk = screenshot.length >= args.autoSaveThreshold || args.saveToDisk;

        if (shouldSaveToDisk) {
          const filepath = await saveScreenshotToDisk(screenshot, type, args.saveToDisk);
          const sizeMB = (screenshot.length / 1_000_000).toFixed(2);
          const fileSize = `${sizeMB}MB`;
          return createSuccessResponse('SCREENSHOT_SAVED', { filepath, fileSize });
        }

        // Small screenshot: return as native image content
        return {
          content: [
            {
              type: 'text',
              text: `Viewport screenshot captured (${(screenshot.length / 1000).toFixed(1)}KB)`,
            },
            {
              type: 'image',
              data: screenshot.toString('base64'),
              mimeType: `image/${type}`,
            },
          ],
        };
      }
    ),

    takeElementScreenshot: createTool(
      'Take a screenshot of a specific element. Automatically saves to disk (default behavior) to avoid token limits. Returns file path. Default quality is 50 for JPEG. Automatically handles breakpoints.',
      takeElementScreenshotSchema,
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

        const error = checkBrowserAutomation(targetCdpManager, targetPuppeteerManager, 'takeElementScreenshot', getConfiguredDebugPort(), true);
        if (error) {
          return error;
        }

        const page = targetPuppeteerManager.getPage();
        const type = args.type;
        const quality = args.quality ?? 50;

        const result = await executeWithPauseDetection(
          targetCdpManager,
          async () => {
            const element = await page.$(args.selector);

            if (!element) {
              return { error: `Element not found: ${args.selector}` };
            }

            // Get screenshot as Buffer
            const screenshot = await element.screenshot({
              type: type as 'png' | 'jpeg',
              ...(type === 'jpeg' && { quality }),
              optimizeForSpeed: true,
            }) as Buffer;

            // Check if we should save to disk
            const shouldSaveToDisk = screenshot.length >= args.autoSaveThreshold || args.saveToDisk;

            if (shouldSaveToDisk) {
              const filepath = await saveScreenshotToDisk(screenshot, type, args.saveToDisk);
              const sizeMB = (screenshot.length / 1_000_000).toFixed(2);
              return {
                selector: args.selector,
                filepath,
                size: `${sizeMB}MB`,
              };
            }

            return {
              selector: args.selector,
              type,
              buffer: screenshot,
              size: `${(screenshot.length / 1000).toFixed(1)}KB`,
            };
          },
          'takeElementScreenshot'
        );

        // Handle errors
        if (result.result?.error) {
          return createErrorResponse('ELEMENT_NOT_FOUND', { selector: args.selector });
        }

        // Handle disk save
        if (result.result?.filepath) {
          return createSuccessResponse('SCREENSHOT_SAVED', {
            filepath: result.result.filepath,
            fileSize: result.result.size,
          });
        }

        // Handle image return - small screenshots
        return {
          content: [
            {
              type: 'text',
              text: `Element screenshot captured for \`${args.selector}\` (${result.result?.size})`,
            },
            {
              type: 'image',
              data: result.result?.buffer?.toString('base64') || '',
              mimeType: `image/${type}`,
            },
          ],
        };
      }
    ),

    printToPDF: createTool(
      'Print the current page to PDF using Chrome (default) or WeasyPrint engine',
      z.object({
        connectionReason: z.string().describe('Brief reason for needing this browser connection (3 descriptive words recommended, e.g., \'search wikipedia results\', \'test checkout flow\'). Auto-creates/reuses tabs.'),
        saveToDisk: z.string().optional().describe('Optional path to save PDF file. If not provided, PDF data is returned as base64 (Chrome engine only).'),
        engine: z.enum(['chrome', 'weasyprint']).optional().default('chrome').describe('PDF rendering engine. Chrome: fast, basic CSS. WeasyPrint: superior CSS Paged Media support (page-break-*, orphans, widows) for professional documents. Default: chrome'),
        // Chrome-specific options
        landscape: z.boolean().optional().default(false).describe('Print in landscape orientation (default: false, Chrome only)'),
        printBackground: z.boolean().optional().default(true).describe('Print background graphics (default: true, Chrome only)'),
        scale: z.number().optional().default(1).describe('Scale of the webpage rendering (default: 1, range: 0.1 to 2, Chrome only)'),
        paperWidth: z.number().optional().describe('Paper width in cm (default: 21.0 for A4, Chrome only)'),
        paperHeight: z.number().optional().describe('Paper height in cm (default: 29.7 for A4, Chrome only)'),
        // WeasyPrint-specific options
        mediaType: z.enum(['print', 'screen']).optional().default('print').describe('CSS media type (default: print, WeasyPrint only)'),
        baseUrl: z.string().optional().describe('Base URL for resolving relative URLs in the HTML (WeasyPrint only)'),
        stylesheets: z.array(z.string()).optional().describe('Additional CSS stylesheet paths to include (WeasyPrint only)'),
        optimizeImages: z.boolean().optional().default(true).describe('Optimize embedded images (default: true, WeasyPrint only)'),
      }).strict(),
      async (args) => {
        // Branch based on engine
        if (args.engine === 'weasyprint') {
          // WeasyPrint engine
          const wpCheck = await checkWeasyPrintAvailable();
          if (!wpCheck.available) {
            return createErrorResponse('WEASYPRINT_NOT_FOUND', {
              error: wpCheck.error || 'WeasyPrint not found',
              version: wpCheck.version
            });
          }

          // Require saveToDisk for WeasyPrint
          if (!args.saveToDisk) {
            return createErrorResponse('PDF_GENERATION_FAILED', {
              error: 'saveToDisk parameter is required when using WeasyPrint engine'
            });
          }

          const resolved = await resolveConnectionFromReason(args.connectionReason);
          if (!resolved) {
            return createErrorResponse('CONNECTION_NOT_FOUND', {
              message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
            });
          }

          const targetPuppeteerManager = resolved.puppeteerManager || puppeteerManager;
          const page = targetPuppeteerManager.getPage();

          try {
            // Extract HTML from current page
            const pageUrl = page.url();
            const htmlContent = await page.content();

            // Create temp directory
            const tempDir = path.join(process.cwd(), '.claude', 'temp');
            await fs.mkdir(tempDir, { recursive: true });

            // Write HTML to temp file
            const timestamp = Date.now();
            const tempHtmlPath = path.join(tempDir, `weasyprint-${timestamp}.html`);
            await fs.writeFile(tempHtmlPath, htmlContent, 'utf-8');

            // Prepare output path
            const outputPath = path.isAbsolute(args.saveToDisk)
              ? args.saveToDisk
              : path.join(process.cwd(), args.saveToDisk);

            // Ensure output directory exists
            await fs.mkdir(path.dirname(outputPath), { recursive: true });

            // Build WeasyPrint command
            const wpArgs = [tempHtmlPath, outputPath];
            wpArgs.push('--media-type', args.mediaType || 'print');

            if (args.baseUrl) {
              wpArgs.push('--base-url', args.baseUrl);
            } else if (pageUrl && !pageUrl.startsWith('about:') && !pageUrl.startsWith('chrome:')) {
              wpArgs.push('--base-url', pageUrl);
            }

            if (args.stylesheets && args.stylesheets.length > 0) {
              for (const stylesheet of args.stylesheets) {
                wpArgs.push('--stylesheet', stylesheet);
              }
            }

            if (args.optimizeImages !== false) {
              wpArgs.push('--optimize-images');
            }

            // Execute WeasyPrint
            const result = await new Promise<{ success: boolean; error?: string }>((resolve) => {
              const wpProcess = spawn('weasyprint', wpArgs);
              let errorOutput = '';

              wpProcess.stderr.on('data', (data) => {
                errorOutput += data.toString();
              });

              wpProcess.on('close', (code) => {
                if (code === 0) {
                  resolve({ success: true });
                } else {
                  resolve({
                    success: false,
                    error: errorOutput || `WeasyPrint exited with code ${code}`
                  });
                }
              });

              wpProcess.on('error', (err) => {
                resolve({
                  success: false,
                  error: `Failed to execute WeasyPrint: ${err.message}`
                });
              });

              setTimeout(() => {
                wpProcess.kill();
                resolve({
                  success: false,
                  error: 'WeasyPrint execution timed out after 30 seconds'
                });
              }, 30000);
            });

            // Clean up temp file
            try {
              await fs.unlink(tempHtmlPath);
            } catch (cleanupError) {
              // Ignore cleanup errors
            }

            if (!result.success) {
              return createErrorResponse('WEASYPRINT_EXECUTION_FAILED', {
                error: result.error || 'Unknown error'
              });
            }

            // Get PDF file size
            const stats = await fs.stat(outputPath);
            const fileSizeMB = (stats.size / 1_000_000).toFixed(2);

            return createSuccessResponse('PDF_SAVED', {
              filepath: outputPath,
              fileSize: `${fileSizeMB} MB`,
              engine: 'weasyprint',
              version: wpCheck.version
            });

          } catch (error: any) {
            return createErrorResponse('PDF_GENERATION_FAILED', {
              error: error.message,
              engine: 'weasyprint'
            });
          }
        }

        // Chrome engine (default)
        const resolved = await resolveConnectionFromReason(args.connectionReason);
        if (!resolved) {
          return createErrorResponse('CONNECTION_NOT_FOUND', {
            message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
          });
        }

        const targetCdpManager = resolved.cdpManager;
        const targetPuppeteerManager = resolved.puppeteerManager || puppeteerManager;
        const page = targetPuppeteerManager.getPage();

        const result = await executeWithPauseDetection(
          targetCdpManager,
          async () => {
            // Validate page has content to print
            const pageUrl = page.url();

            // Reject chrome:// and about: URLs
            if (pageUrl.startsWith('chrome://') || pageUrl.startsWith('about:')) {
              return {
                error: `Cannot print ${pageUrl}. Please navigate to a web page with content first.`
              };
            }

            // Check if page has meaningful content
            const hasContent = await page.evaluate(() => {
              // @ts-ignore - This code runs in browser context
              const body = document.body;
              if (!body) return false;

              // Check if body has text content
              const text = body.innerText.trim();
              if (text.length > 10) return true;

              // Check if body has visible elements (images, videos, etc.)
              const elements = body.querySelectorAll('img, video, canvas, svg, iframe');
              if (elements.length > 0) return true;

              // Check if there are any styled elements with dimensions
              const styledElements = body.querySelectorAll('div, section, article, main');
              for (const el of Array.from(styledElements)) {
                // @ts-ignore - This code runs in browser context
                const rect = el.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                  return true;
                }
              }

              return false;
            });

            if (!hasContent) {
              return {
                error: 'Page appears to be blank or has no printable content. Please navigate to a page with content first.'
              };
            }

            const cdpSession = await page.createCDPSession();

            // A4 defaults in cm: 21.0 x 29.7
            const defaultWidthCm = 21.0;
            const defaultHeightCm = 29.7;

            // Convert cm to inches (CDP expects inches): 1 cm = 0.393701 inches
            const cmToInches = (cm: number) => cm * 0.393701;

            const paperWidthInches = args.paperWidth ? cmToInches(args.paperWidth) : cmToInches(defaultWidthCm);
            const paperHeightInches = args.paperHeight ? cmToInches(args.paperHeight) : cmToInches(defaultHeightCm);

            // Use CDP Page.printToPDF command
            const pdfData = await cdpSession.send('Page.printToPDF', {
              landscape: args.landscape,
              printBackground: args.printBackground,
              scale: args.scale,
              paperWidth: paperWidthInches,
              paperHeight: paperHeightInches,
            });

            const buffer = Buffer.from(pdfData.data, 'base64');

            // Save to disk if path provided
            if (args.saveToDisk) {
              const timestamp = Date.now();
              const filepath = args.saveToDisk || path.join(process.cwd(), '.claude', 'pdfs', `print-${timestamp}.pdf`);
              const absolutePath = path.isAbsolute(filepath) ? filepath : path.join(process.cwd(), filepath);

              // Ensure directory exists
              await fs.mkdir(path.dirname(absolutePath), { recursive: true });
              await fs.writeFile(absolutePath, buffer);

              const sizeMB = (buffer.length / 1_000_000).toFixed(2);
              return {
                filepath: absolutePath,
                size: `${sizeMB} MB`,
              };
            }

            // Return base64 data
            return {
              base64: pdfData.data,
              size: `${(buffer.length / 1_000_000).toFixed(2)} MB`,
            };
          },
          'printToPDF'
        );

        // Check for errors (including validation errors)
        if (!result.success || result.error || result.result?.error) {
          return createErrorResponse('PDF_GENERATION_FAILED', {
            error: result.result?.error || result.error || 'Unknown error occurred',
          });
        }

        // Handle disk save
        if (result.result?.filepath) {
          return createSuccessResponse('PDF_SAVED', {
            filepath: result.result.filepath,
            fileSize: result.result.size,
            engine: 'chrome'
          });
        }

        // Return PDF as base64
        return createSuccessResponse('PDF_GENERATED', {
          size: result.result?.size,
          note: 'PDF generated successfully. Use saveToDisk parameter to save to a file.',
        });
      }
    ),
  };
}
