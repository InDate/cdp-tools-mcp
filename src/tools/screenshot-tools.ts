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
import { randomBytes } from 'crypto';

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

/**
 * Validate page has printable content
 */
async function validatePageContent(page: any): Promise<{ valid: boolean; error?: string }> {
  const pageUrl = page.url();

  // Reject chrome:// and about: URLs
  if (pageUrl.startsWith('chrome://') || pageUrl.startsWith('about:')) {
    return {
      valid: false,
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
      valid: false,
      error: 'Page appears to be blank or has no printable content. Please navigate to a page with content first.'
    };
  }

  return { valid: true };
}

/**
 * Generate PDF using WeasyPrint engine
 */
async function generatePDFWithWeasyPrint(
  page: any,
  args: {
    saveToDisk: string;
    mediaType?: 'print' | 'screen';
    baseUrl?: string;
    stylesheets?: string[];
    optimizeImages?: boolean;
    timeout?: number;
  }
): Promise<{ success: boolean; filepath?: string; fileSize?: string; version?: string; error?: string; context?: any }> {
  // Check if WeasyPrint is available
  const wpCheck = await checkWeasyPrintAvailable();
  if (!wpCheck.available) {
    return {
      success: false,
      error: wpCheck.error || 'WeasyPrint not found',
      context: { version: wpCheck.version }
    };
  }

  // Validate page content
  const contentValidation = await validatePageContent(page);
  if (!contentValidation.valid) {
    return {
      success: false,
      error: contentValidation.error
    };
  }

  const pageUrl = page.url();

  // Prepare output path
  const outputPath = path.isAbsolute(args.saveToDisk)
    ? args.saveToDisk
    : path.join(process.cwd(), args.saveToDisk);

  // Ensure output directory exists
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  // Build WeasyPrint command - use URL directly instead of temp file
  const wpArgs = [pageUrl, outputPath];
  wpArgs.push('--media-type', args.mediaType || 'print');

  if (args.baseUrl) {
    wpArgs.push('--base-url', args.baseUrl);
  }

  if (args.stylesheets && args.stylesheets.length > 0) {
    for (const stylesheet of args.stylesheets) {
      wpArgs.push('--stylesheet', stylesheet);
    }
  }

  if (args.optimizeImages !== false) {
    wpArgs.push('--optimize-images');
  }

  const timeoutMs = args.timeout || 30000;

  // Execute WeasyPrint
  const result = await new Promise<{ success: boolean; error?: string; stderr?: string }>((resolve) => {
    const wpProcess = spawn('weasyprint', wpArgs);
    let errorOutput = '';
    let resolved = false;

    wpProcess.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    wpProcess.on('close', (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutHandle);

      if (code === 0) {
        resolve({ success: true });
      } else {
        resolve({
          success: false,
          error: errorOutput || `WeasyPrint exited with code ${code}`,
          stderr: errorOutput
        });
      }
    });

    wpProcess.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutHandle);

      resolve({
        success: false,
        error: `Failed to execute WeasyPrint: ${err.message}`
      });
    });

    const timeoutHandle = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      wpProcess.kill();

      resolve({
        success: false,
        error: `WeasyPrint execution timed out after ${timeoutMs}ms`
      });
    }, timeoutMs);
  });

  if (!result.success) {
    return {
      success: false,
      error: result.error || 'Unknown error',
      context: {
        pageUrl,
        command: `weasyprint ${wpArgs.join(' ')}`,
        stderr: result.stderr,
        version: wpCheck.version
      }
    };
  }

  // Get PDF file size
  const stats = await fs.stat(outputPath);
  const fileSizeMB = (stats.size / 1_000_000).toFixed(2);

  return {
    success: true,
    filepath: outputPath,
    fileSize: `${fileSizeMB} MB`,
    version: wpCheck.version
  };
}

/**
 * Generate PDF using Chrome engine
 */
async function generatePDFWithChrome(
  page: any,
  cdpManager: any,
  args: {
    saveToDisk?: string;
    landscape?: boolean;
    printBackground?: boolean;
    scale?: number;
    paperWidthCm?: number;
    paperHeightCm?: number;
  }
): Promise<{ success: boolean; filepath?: string; fileSize?: string; base64?: string; error?: string; context?: any }> {
  // Validate page content
  const contentValidation = await validatePageContent(page);
  if (!contentValidation.valid) {
    return {
      success: false,
      error: contentValidation.error
    };
  }

  const pageUrl = page.url();

  try {
    const cdpSession = await page.createCDPSession();

    // A4 defaults in cm: 21.0 x 29.7
    const defaultWidthCm = 21.0;
    const defaultHeightCm = 29.7;

    // Convert cm to inches (CDP expects inches): 1 cm = 0.393701 inches
    const cmToInches = (cm: number) => cm * 0.393701;

    const paperWidthInches = args.paperWidthCm ? cmToInches(args.paperWidthCm) : cmToInches(defaultWidthCm);
    const paperHeightInches = args.paperHeightCm ? cmToInches(args.paperHeightCm) : cmToInches(defaultHeightCm);

    // Use CDP Page.printToPDF command
    const pdfData = await cdpSession.send('Page.printToPDF', {
      landscape: args.landscape ?? false,
      printBackground: args.printBackground ?? true,
      scale: args.scale ?? 1,
      paperWidth: paperWidthInches,
      paperHeight: paperHeightInches,
    });

    const buffer = Buffer.from(pdfData.data, 'base64');

    // Save to disk if path provided
    if (args.saveToDisk) {
      const filepath = path.isAbsolute(args.saveToDisk)
        ? args.saveToDisk
        : path.join(process.cwd(), args.saveToDisk);

      // Ensure directory exists
      await fs.mkdir(path.dirname(filepath), { recursive: true });
      await fs.writeFile(filepath, buffer);

      const sizeMB = (buffer.length / 1_000_000).toFixed(2);
      return {
        success: true,
        filepath,
        fileSize: `${sizeMB} MB`,
      };
    }

    // Return base64 data
    return {
      success: true,
      base64: pdfData.data,
      fileSize: `${(buffer.length / 1_000_000).toFixed(2)} MB`,
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message,
      context: {
        pageUrl,
        options: {
          landscape: args.landscape,
          printBackground: args.printBackground,
          scale: args.scale,
          paperWidthCm: args.paperWidthCm,
          paperHeightCm: args.paperHeightCm
        }
      }
    };
  }
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
      'Generate PDF from current page. Chrome: fast rendering for previews and simple layouts. WeasyPrint: professional quality with superior CSS Paged Media support (page-break-after, orphans, widows) for production documents and reports. Default: chrome',
      z.union([
        // Chrome engine schema (engine optional, defaults to 'chrome')
        z.object({
          engine: z.literal('chrome').optional(),
          connectionReason: z.string().describe('Brief reason for needing this browser connection'),
          saveToDisk: z.string().optional().describe('Optional path to save PDF file. If not provided, PDF data is returned as base64.'),
          landscape: z.boolean().optional().default(false).describe('Print in landscape orientation (default: false)'),
          printBackground: z.boolean().optional().default(true).describe('Print background graphics (default: true)'),
          scale: z.number().optional().default(1).describe('Scale of the webpage rendering (default: 1, range: 0.1 to 2)'),
          paperWidthCm: z.number().optional().describe('Paper width in centimeters (default: 21.0 for A4)'),
          paperHeightCm: z.number().optional().describe('Paper height in centimeters (default: 29.7 for A4)'),
        }).strict(),
        // WeasyPrint engine schema (engine required)
        z.object({
          engine: z.literal('weasyprint'),
          connectionReason: z.string().describe('Brief reason for needing this browser connection'),
          saveToDisk: z.string().describe('Path to save PDF file (required for WeasyPrint)'),
          mediaType: z.enum(['print', 'screen']).optional().default('print').describe('CSS media type (default: print)'),
          baseUrl: z.string().optional().describe('Base URL for resolving relative URLs in the HTML'),
          stylesheets: z.array(z.string()).optional().describe('Additional CSS stylesheet paths to include'),
          optimizeImages: z.boolean().optional().default(true).describe('Optimize embedded images (default: true)'),
          timeout: z.number().optional().describe('Timeout in milliseconds (default: 30000, max: 120000)').refine(val => val === undefined || (val >= 1000 && val <= 120000), {
            message: 'Timeout must be between 1000ms and 120000ms'
          }),
        }).strict(),
      ]).transform((val) => ({
        ...val,
        engine: val.engine || 'chrome' as const
      })),
      async (args) => {
        // Get page connection
        const resolved = await resolveConnectionFromReason(args.connectionReason);
        if (!resolved) {
          return createErrorResponse('CONNECTION_NOT_FOUND', {
            message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
          });
        }

        const targetCdpManager = resolved.cdpManager;
        const targetPuppeteerManager = resolved.puppeteerManager || puppeteerManager;
        const page = targetPuppeteerManager.getPage();

        // Branch based on engine
        if (args.engine === 'weasyprint') {
          // WeasyPrint engine - TypeScript needs help with union types
          const wpArgs = args as {
            engine: 'weasyprint';
            connectionReason: string;
            saveToDisk: string;
            mediaType?: 'print' | 'screen';
            baseUrl?: string;
            stylesheets?: string[];
            optimizeImages?: boolean;
            timeout?: number;
          };

          const result = await generatePDFWithWeasyPrint(page, {
            saveToDisk: wpArgs.saveToDisk,
            mediaType: wpArgs.mediaType,
            baseUrl: wpArgs.baseUrl,
            stylesheets: wpArgs.stylesheets,
            optimizeImages: wpArgs.optimizeImages,
            timeout: wpArgs.timeout,
          });

          if (!result.success) {
            if (result.error?.includes('WeasyPrint not found') || result.error?.includes('not installed')) {
              return createErrorResponse('WEASYPRINT_NOT_FOUND', {
                error: result.error,
                ...result.context
              });
            }

            return createErrorResponse('WEASYPRINT_EXECUTION_FAILED', {
              error: result.error || 'Unknown error',
              ...result.context
            });
          }

          return createSuccessResponse('PDF_SAVED', {
            filepath: result.filepath!,
            fileSize: result.fileSize!,
            engine: 'weasyprint',
            version: result.version
          });
        }

        // Chrome engine - TypeScript needs help with union types
        const chromeArgs = args as {
          engine?: 'chrome';
          connectionReason: string;
          saveToDisk?: string;
          landscape?: boolean;
          printBackground?: boolean;
          scale?: number;
          paperWidthCm?: number;
          paperHeightCm?: number;
        };

        const result = await executeWithPauseDetection(
          targetCdpManager,
          async () => {
            return await generatePDFWithChrome(page, targetCdpManager, {
              saveToDisk: chromeArgs.saveToDisk,
              landscape: chromeArgs.landscape,
              printBackground: chromeArgs.printBackground,
              scale: chromeArgs.scale,
              paperWidthCm: chromeArgs.paperWidthCm,
              paperHeightCm: chromeArgs.paperHeightCm,
            });
          },
          'printToPDF'
        );

        // Handle Chrome result
        if (!result.success || result.result?.error) {
          return createErrorResponse('PDF_GENERATION_FAILED', {
            error: result.result?.error || result.error || 'Unknown error occurred',
            ...result.result?.context
          });
        }

        // Handle disk save
        if (result.result?.filepath) {
          return createSuccessResponse('PDF_SAVED', {
            filepath: result.result.filepath,
            fileSize: result.result.fileSize!,
            engine: 'chrome'
          });
        }

        // Return PDF as base64
        return createSuccessResponse('PDF_GENERATED', {
          size: result.result?.fileSize,
          engine: 'chrome',
          note: 'PDF generated successfully. Use saveToDisk parameter to save to a file.',
        });
      }
    ),
  };
}
