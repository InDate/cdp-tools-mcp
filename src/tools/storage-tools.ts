/**
 * Storage Access Tools
 */

import { z } from 'zod';
import type { CDPManager } from '../cdp-manager.js';
import { PuppeteerManager } from '../puppeteer-manager.js';
import { executeWithPauseDetection, formatActionResult } from '../debugger-aware-wrapper.js';
import { checkBrowserAutomation, formatErrorResponse } from '../error-helpers.js';
import { createTool } from '../validation-helpers.js';

// Zod schemas for storage tools
const getCookiesSchema = z.object({
  url: z.string().optional(),
}).strict();

const setCookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string().optional(),
  path: z.string().optional(),
  expires: z.number().optional(),
  httpOnly: z.boolean().default(false),
  secure: z.boolean().default(false),
}).strict();

const getLocalStorageSchema = z.object({
  key: z.string().optional(),
}).strict();

const setLocalStorageSchema = z.object({
  key: z.string(),
  value: z.string(),
}).strict();

const clearStorageSchema = z.object({
  types: z.array(z.enum(['cookies', 'localStorage', 'sessionStorage'])).optional(),
}).strict();

export function createStorageTools(puppeteerManager: PuppeteerManager, cdpManager: CDPManager) {
  return {
    getCookies: createTool(
      'Get browser cookies',
      getCookiesSchema,
      async (args) => {
        if (!puppeteerManager.isConnected()) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'Not connected to browser',
                }, null, 2),
              },
            ],
          };
        }

        const page = puppeteerManager.getPage();
        const cookies = args.url ? await page.cookies(args.url) : await page.cookies();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                cookies,
                count: cookies.length,
              }, null, 2),
            },
          ],
        };
      }
    ),

    setCookie: createTool(
      'Set a browser cookie',
      setCookieSchema,
      async (args) => {
        if (!puppeteerManager.isConnected()) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'Not connected to browser',
                }, null, 2),
              },
            ],
          };
        }

        const page = puppeteerManager.getPage();

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

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: `Cookie ${args.name} set`,
                cookie,
              }, null, 2),
            },
          ],
        };
      }
    ),

    getLocalStorage: createTool(
      'Get localStorage items. Automatically handles breakpoints.',
      getLocalStorageSchema,
      async (args) => {
        if (!puppeteerManager.isConnected()) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'Not connected to browser',
                }, null, 2),
              },
            ],
          };
        }

        const page = puppeteerManager.getPage();

        const result = await executeWithPauseDetection(
          cdpManager,
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

        const response = formatActionResult(result, 'getLocalStorage', { localStorage: result.result });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      }
    ),

    setLocalStorage: createTool(
      'Set a localStorage item. Automatically handles breakpoints.',
      setLocalStorageSchema,
      async (args) => {
        if (!puppeteerManager.isConnected()) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'Not connected to browser',
                }, null, 2),
              },
            ],
          };
        }

        const page = puppeteerManager.getPage();

        const result = await executeWithPauseDetection(
          cdpManager,
          () => page.evaluate((key: string, value: string) => {
            localStorage.setItem(key, value);
          }, args.key, args.value),
          'setLocalStorage'
        );

        const response = formatActionResult(result, 'setLocalStorage', {
          key: args.key,
          value: args.value,
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
    ),

    clearStorage: createTool(
      'Clear cookies and storage. Automatically handles breakpoints.',
      clearStorageSchema,
      async (args) => {
        if (!puppeteerManager.isConnected()) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'Not connected to browser',
                }, null, 2),
              },
            ],
          };
        }

        const page = puppeteerManager.getPage();
        const types = args.types || ['cookies', 'localStorage', 'sessionStorage'];

        const result = await executeWithPauseDetection(
          cdpManager,
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

        const response = formatActionResult(result, 'clearStorage', result.result);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      }
    ),
  };
}
