/**
 * Storage Access Tools
 */

import { PuppeteerManager } from '../puppeteer-manager.js';

export function createStorageTools(puppeteerManager: PuppeteerManager) {
  return {
    getCookies: {
      description: 'Get browser cookies',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'Filter cookies by URL (optional)',
          },
        },
      },
      handler: async (args: any) => {
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
        const cookies = await page.cookies(args.url);

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
      },
    },

    setCookie: {
      description: 'Set a browser cookie',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Cookie name',
          },
          value: {
            type: 'string',
            description: 'Cookie value',
          },
          domain: {
            type: 'string',
            description: 'Cookie domain (optional)',
          },
          path: {
            type: 'string',
            description: 'Cookie path (default: /)',
          },
          expires: {
            type: 'number',
            description: 'Expiration timestamp in seconds (optional)',
          },
          httpOnly: {
            type: 'boolean',
            description: 'HTTP only flag (default: false)',
          },
          secure: {
            type: 'boolean',
            description: 'Secure flag (default: false)',
          },
        },
        required: ['name', 'value'],
      },
      handler: async (args: any) => {
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
          httpOnly: args.httpOnly || false,
          secure: args.secure || false,
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
      },
    },

    getLocalStorage: {
      description: 'Get localStorage items',
      inputSchema: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'Specific key to retrieve (optional, returns all if not specified)',
          },
        },
      },
      handler: async (args: any) => {
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

        const result = await page.evaluate((key: string | undefined) => {
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
        }, args.key);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                localStorage: result,
              }, null, 2),
            },
          ],
        };
      },
    },

    setLocalStorage: {
      description: 'Set a localStorage item',
      inputSchema: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'The key to set',
          },
          value: {
            type: 'string',
            description: 'The value to set',
          },
        },
        required: ['key', 'value'],
      },
      handler: async (args: any) => {
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

        await page.evaluate((key: string, value: string) => {
          localStorage.setItem(key, value);
        }, args.key, args.value);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: `localStorage item ${args.key} set`,
                key: args.key,
                value: args.value,
              }, null, 2),
            },
          ],
        };
      },
    },

    clearStorage: {
      description: 'Clear cookies and storage',
      inputSchema: {
        type: 'object',
        properties: {
          types: {
            type: 'array',
            description: 'Types of storage to clear (cookies, localStorage, sessionStorage)',
            items: {
              type: 'string',
              enum: ['cookies', 'localStorage', 'sessionStorage'],
            },
          },
        },
      },
      handler: async (args: any) => {
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

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'Storage cleared',
                cleared,
              }, null, 2),
            },
          ],
        };
      },
    },
  };
}
