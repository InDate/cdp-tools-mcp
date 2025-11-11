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
  };
}
