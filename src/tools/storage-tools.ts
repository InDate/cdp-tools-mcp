/**
 * Storage Access Tools
 */

import { z } from 'zod';
import type { CDPManager } from '../cdp-manager.js';
import { PuppeteerManager } from '../puppeteer-manager.js';
import { executeWithPauseDetection, formatActionResult } from '../debugger-aware-wrapper.js';
import { checkBrowserAutomation, formatErrorResponse } from '../error-helpers.js';
import { createTool } from '../validation-helpers.js';
import { getConfiguredDebugPort } from '../index.js';
import { createSuccessResponse, createErrorResponse, formatCodeBlock } from '../messages.js';

// Zod schemas for storage tools
const getCookiesSchema = z.object({
  url: z.string().optional(),
  connectionReason: z.string().optional().describe('Brief reason for needing this browser connection (3 descriptive words recommended). Requires existing tab or connection.'),
}).strict();

const setCookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string().optional(),
  path: z.string().optional(),
  expires: z.number().optional(),
  httpOnly: z.boolean().default(false),
  secure: z.boolean().default(false),
  connectionReason: z.string().optional().describe('Brief reason for needing this browser connection (3 descriptive words recommended). Requires existing tab or connection.'),
}).strict();

const getLocalStorageSchema = z.object({
  key: z.string().optional(),
  connectionReason: z.string().optional().describe('Brief reason for needing this browser connection (3 descriptive words recommended). Requires existing tab or connection.'),
}).strict();

const setLocalStorageSchema = z.object({
  key: z.string(),
  value: z.string(),
  connectionReason: z.string().optional().describe('Brief reason for needing this browser connection (3 descriptive words recommended). Requires existing tab or connection.'),
}).strict();

const clearStorageSchema = z.object({
  types: z.array(z.enum(['cookies', 'localStorage', 'sessionStorage'])).optional(),
  connectionReason: z.string().optional().describe('Brief reason for needing this browser connection (3 descriptive words recommended). Requires existing tab or connection.'),
}).strict();

export function createStorageTools(
  puppeteerManager: PuppeteerManager,
  cdpManager: CDPManager,
  resolveConnectionFromReason?: (connectionReason: string) => Promise<{
    connection: any;
    cdpManager: CDPManager;
    puppeteerManager: any;
    consoleMonitor: any;
    networkMonitor: any;
  } | null>
) {
  return {
    getCookies: createTool(
      'Get browser cookies',
      getCookiesSchema,
      async (args) => {
        const { connectionReason } = args;

        // Resolve connection if connectionReason is provided
        let targetPuppeteerManager = puppeteerManager;
        if (connectionReason && resolveConnectionFromReason) {
          const resolved = await resolveConnectionFromReason(connectionReason);
          if (!resolved || !resolved.puppeteerManager) {
            return createErrorResponse('PUPPETEER_NOT_CONNECTED');
          }
          targetPuppeteerManager = resolved.puppeteerManager;
        }

        if (!targetPuppeteerManager.isConnected()) {
          return createErrorResponse('PUPPETEER_NOT_CONNECTED');
        }

        const page = targetPuppeteerManager.getPage();
        const cookies = args.url ? await page.cookies(args.url) : await page.cookies();

        const markdown = `## Browser Cookies\n\n**Count:** ${cookies.length}\n\n${formatCodeBlock(cookies)}`;
        return {
          content: [
            {
              type: 'text',
              text: markdown,
            },
          ],
        };
      }
    ),

    setCookie: createTool(
      'Set a browser cookie',
      setCookieSchema,
      async (args) => {
        const { connectionReason } = args;

        // Resolve connection if connectionReason is provided
        let targetPuppeteerManager = puppeteerManager;
        if (connectionReason && resolveConnectionFromReason) {
          const resolved = await resolveConnectionFromReason(connectionReason);
          if (!resolved || !resolved.puppeteerManager) {
            return createErrorResponse('PUPPETEER_NOT_CONNECTED');
          }
          targetPuppeteerManager = resolved.puppeteerManager;
        }

        if (!targetPuppeteerManager.isConnected()) {
          return createErrorResponse('PUPPETEER_NOT_CONNECTED');
        }

        const page = targetPuppeteerManager.getPage();

        const cookie: any = {
          name: args.name,
          value: args.value,
          domain: args.domain,
          path: args.path || '/',
          expires: args.expires,
          httpOnly: args.httpOnly,
          secure: args.secure,
        };

        await page.setCookie(cookie);

        return createSuccessResponse('COOKIE_SET_SUCCESS', {
          name: args.name
        }, cookie);
      }
    ),

    getLocalStorage: createTool(
      'Get localStorage items. Automatically handles breakpoints.',
      getLocalStorageSchema,
      async (args) => {
        const { connectionReason } = args;

        // Resolve connection if connectionReason is provided
        let targetPuppeteerManager = puppeteerManager;
        let targetCdpManager = cdpManager;
        if (connectionReason && resolveConnectionFromReason) {
          const resolved = await resolveConnectionFromReason(connectionReason);
          if (!resolved || !resolved.puppeteerManager) {
            return createErrorResponse('PUPPETEER_NOT_CONNECTED');
          }
          targetPuppeteerManager = resolved.puppeteerManager;
          targetCdpManager = resolved.cdpManager;
        }

        if (!targetPuppeteerManager.isConnected()) {
          return createErrorResponse('PUPPETEER_NOT_CONNECTED');
        }

        const page = targetPuppeteerManager.getPage();

        const result = await executeWithPauseDetection(
          targetCdpManager,
          () => page.evaluate((key: string | undefined) => {
            if (key) {
              return { [key]: localStorage.getItem(key) };
            } else {
              const items: Record<string, string | null> = {};
              for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k) {
                  items[k] = localStorage.getItem(k);
                }
              }
              return items;
            }
          }, args.key),
          'getLocalStorage'
        );

        const markdown = `## localStorage\n\n${formatCodeBlock(result.result)}`;
        return {
          content: [
            {
              type: 'text',
              text: markdown,
            },
          ],
        };
      }
    ),

    setLocalStorage: createTool(
      'Set a localStorage item. Automatically handles breakpoints.',
      setLocalStorageSchema,
      async (args) => {
        const { connectionReason } = args;

        // Resolve connection if connectionReason is provided
        let targetPuppeteerManager = puppeteerManager;
        let targetCdpManager = cdpManager;
        if (connectionReason && resolveConnectionFromReason) {
          const resolved = await resolveConnectionFromReason(connectionReason);
          if (!resolved || !resolved.puppeteerManager) {
            return createErrorResponse('PUPPETEER_NOT_CONNECTED');
          }
          targetPuppeteerManager = resolved.puppeteerManager;
          targetCdpManager = resolved.cdpManager;
        }

        if (!targetPuppeteerManager.isConnected()) {
          return createErrorResponse('PUPPETEER_NOT_CONNECTED');
        }

        const page = targetPuppeteerManager.getPage();

        await executeWithPauseDetection(
          targetCdpManager,
          () => page.evaluate((key: string, value: string) => {
            localStorage.setItem(key, value);
          }, args.key, args.value),
          'setLocalStorage'
        );

        return createSuccessResponse('LOCAL_STORAGE_SET_SUCCESS', {
          key: args.key,
          value: args.value
        });
      }
    ),

    clearStorage: createTool(
      'Clear cookies and storage. Automatically handles breakpoints.',
      clearStorageSchema,
      async (args) => {
        const { connectionReason } = args;

        // Resolve connection if connectionReason is provided
        let targetPuppeteerManager = puppeteerManager;
        let targetCdpManager = cdpManager;
        if (connectionReason && resolveConnectionFromReason) {
          const resolved = await resolveConnectionFromReason(connectionReason);
          if (!resolved || !resolved.puppeteerManager) {
            return createErrorResponse('PUPPETEER_NOT_CONNECTED');
          }
          targetPuppeteerManager = resolved.puppeteerManager;
          targetCdpManager = resolved.cdpManager;
        }

        if (!targetPuppeteerManager.isConnected()) {
          return createErrorResponse('PUPPETEER_NOT_CONNECTED');
        }

        const page = targetPuppeteerManager.getPage();
        const types = args.types || ['cookies', 'localStorage', 'sessionStorage'];

        const result = await executeWithPauseDetection(
          targetCdpManager,
          async () => {
            const cleared: string[] = [];

            if (types.includes('cookies')) {
              const cookies = await page.cookies();
              if (cookies.length > 0) {
                await page.deleteCookie(...cookies);
              }
              cleared.push('cookies');
            }

            if (types.includes('localStorage') || types.includes('sessionStorage')) {
              await page.evaluate((storageTypes: string[]) => {
                if (storageTypes.includes('localStorage')) {
                  localStorage.clear();
                }
                if (storageTypes.includes('sessionStorage')) {
                  sessionStorage.clear();
                }
              }, types);

              if (types.includes('localStorage')) cleared.push('localStorage');
              if (types.includes('sessionStorage')) cleared.push('sessionStorage');
            }

            return { cleared };
          },
          'clearStorage'
        );

        if (!result.result) {
          return createSuccessResponse('STORAGE_CLEARED', { types: types.join(', ') });
        }

        const storageResult = result.result;
        return createSuccessResponse('STORAGE_CLEARED', { types: storageResult.cleared.join(', ') });
      }
    ),
  };
}
