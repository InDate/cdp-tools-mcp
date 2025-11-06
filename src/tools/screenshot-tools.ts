/**
 * Screenshot Tools
 */

import { z } from 'zod';
import type { CDPManager } from '../cdp-manager.js';
import { PuppeteerManager } from '../puppeteer-manager.js';
import { executeWithPauseDetection, formatActionResult } from '../debugger-aware-wrapper.js';
import { checkBrowserAutomation, formatErrorResponse } from '../error-helpers.js';
import { createTool } from '../validation-helpers.js';
import { promises as fs } from 'fs';
import path from 'path';

export function createScreenshotTools(puppeteerManager: PuppeteerManager, cdpManager: CDPManager) {
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
  }).strict();

  const takeViewportScreenshotSchema = z.object({
    type: z.enum(['png', 'jpeg']).default('jpeg'),
    quality: z.number().min(0).max(100).optional(),
    clip: clipSchema.optional(),
    saveToDisk: z.string().optional(),
    autoSaveThreshold: z.number().default(1).describe('Auto-save to disk if size >= this (bytes). Default: 1 byte (always saves)'),
  }).strict();

  const takeElementScreenshotSchema = z.object({
    selector: z.string(),
    type: z.enum(['png', 'jpeg']).default('jpeg'),
    quality: z.number().min(0).max(100).optional(),
    saveToDisk: z.string().optional(),
    autoSaveThreshold: z.number().default(1).describe('Auto-save to disk if size >= this (bytes). Default: 1 byte (always saves)'),
  }).strict();

  return {
    takeScreenshot: createTool(
      'Take a screenshot of the full page. Automatically saves to disk (default behavior) to avoid token limits. Returns file path. Default quality is 30 for JPEG.',
      takeScreenshotSchema,
      async (args) => {
        const error = checkBrowserAutomation(cdpManager, puppeteerManager, 'takeScreenshot');
        if (error) {
          return formatErrorResponse(error);
        }

        const page = puppeteerManager.getPage();
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
          return {
            content: [
              {
                type: 'text',
                text: `Screenshot saved to ${filepath} (${sizeMB}MB, ${screenshot.length.toLocaleString()} bytes)`,
              },
            ],
          };
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
        const error = checkBrowserAutomation(cdpManager, puppeteerManager, 'takeViewportScreenshot');
        if (error) {
          return formatErrorResponse(error);
        }

        const page = puppeteerManager.getPage();
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
          return {
            content: [
              {
                type: 'text',
                text: `Viewport screenshot saved to ${filepath} (${sizeMB}MB, ${screenshot.length.toLocaleString()} bytes)`,
              },
            ],
          };
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
        const error = checkBrowserAutomation(cdpManager, puppeteerManager, 'takeElementScreenshot');
        if (error) {
          return formatErrorResponse(error);
        }

        const page = puppeteerManager.getPage();
        const type = args.type;
        const quality = args.quality ?? 50;

        const result = await executeWithPauseDetection(
          cdpManager,
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
          const response = formatActionResult(result, 'takeElementScreenshot', result.result);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(response, null, 2),
              },
            ],
          };
        }

        // Handle disk save
        if (result.result?.filepath) {
          const response = formatActionResult(result, 'takeElementScreenshot', {
            selector: result.result.selector,
            filepath: result.result.filepath,
            size: result.result.size,
          });
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(response, null, 2),
              },
            ],
          };
        }

        // Handle image return
        const response = formatActionResult(result, 'takeElementScreenshot', {
          selector: result.result?.selector,
          size: result.result?.size,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(response, null, 2),
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
  };
}
