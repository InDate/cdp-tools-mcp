/**
 * Storage Access Tools
 */

import { z } from 'zod';
import type { CDPManager } from '../cdp-manager.js';
import { PuppeteerManager } from '../puppeteer-manager.js';
import { executeWithPauseDetection, formatActionResult } from '../debugger-aware-wrapper.js';
import { checkBrowserAutomation, formatErrorResponse } from '../error-helpers.js';
import { createTool } from '../validation-helpers.js';
import { getConfiguredDebugPort } from '../port-config.js';
import { createSuccessResponse, createErrorResponse, formatCodeBlock } from '../messages.js';

// Consolidated schema for storage tools
const storageSchema = z.object({
  action: z.enum(['getCookies', 'setCookie', 'getLocalStorage', 'setLocalStorage', 'clear']).describe('Storage action: getCookies (get cookies), setCookie (set cookie), getLocalStorage (get localStorage), setLocalStorage (set localStorage), clear (clear storage)'),
  connectionReason: z.string().optional().describe('Connection reference (use the reference from launchChrome output, e.g., "unnamed-connection-default" or your renamed tab)'),
  // Parameters for getCookies action
  url: z.string().optional().describe('URL to get cookies for (optional for getCookies action)'),
  // Parameters for setCookie action
  name: z.string().optional().describe('Cookie name (required for setCookie action)'),
  value: z.string().optional().describe('Cookie/storage value (required for setCookie and setLocalStorage actions)'),
  domain: z.string().optional().describe('Cookie domain (optional for setCookie action)'),
  path: z.string().optional().describe('Cookie path (optional for setCookie action)'),
  expires: z.number().optional().describe('Cookie expiration timestamp (optional for setCookie action)'),
  httpOnly: z.boolean().optional().describe('HTTP only cookie (optional for setCookie action, default: false)'),
  secure: z.boolean().optional().describe('Secure cookie (optional for setCookie action, default: false)'),
  // Parameters for getLocalStorage and setLocalStorage actions
  key: z.string().optional().describe('localStorage key (optional for getLocalStorage, required for setLocalStorage)'),
  // Parameters for clear action
  reason: z.string().optional().describe('Why storage needs to be cleared (required for clear action)'),
  types: z.array(z.enum(['cookies', 'localStorage', 'sessionStorage'])).optional().describe('Storage types to clear (for clear action, default: all)'),
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
    storage: createTool(
      'Access and manage browser storage (cookies, localStorage, sessionStorage). Actions: getCookies (get cookies), setCookie (set cookie), getLocalStorage (get localStorage), setLocalStorage (set localStorage), clear (clear storage)',
      storageSchema,
      async (args) => {
        const { action, connectionReason } = args;

        // Validate required parameters for each action
        if (action === 'setCookie') {
          if (!args.name) {
            return createErrorResponse('MISSING_PARAMETER', {
              action: 'setCookie',
              missing: 'name',
              message: 'The "setCookie" action requires a "name" parameter'
            });
          }
          if (!args.value) {
            return createErrorResponse('MISSING_PARAMETER', {
              action: 'setCookie',
              missing: 'value',
              message: 'The "setCookie" action requires a "value" parameter'
            });
          }
        }
        if (action === 'setLocalStorage') {
          if (!args.key) {
            return createErrorResponse('MISSING_PARAMETER', {
              action: 'setLocalStorage',
              missing: 'key',
              message: 'The "setLocalStorage" action requires a "key" parameter'
            });
          }
          if (!args.value) {
            return createErrorResponse('MISSING_PARAMETER', {
              action: 'setLocalStorage',
              missing: 'value',
              message: 'The "setLocalStorage" action requires a "value" parameter'
            });
          }
        }
        if (action === 'clear' && !args.reason) {
          return createErrorResponse('MISSING_PARAMETER', {
            action: 'clear',
            missing: 'reason',
            message: 'The "clear" action requires a "reason" parameter'
          });
        }

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

        // Handle each action
        switch (action) {
          case 'getCookies': {
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

          case 'setCookie': {
            const cookie: any = {
              name: args.name!,
              value: args.value!,
              domain: args.domain,
              path: args.path || '/',
              expires: args.expires,
              httpOnly: args.httpOnly ?? false,
              secure: args.secure ?? false,
            };

            await page.setCookie(cookie);

            return createSuccessResponse('COOKIE_SET_SUCCESS', {
              name: args.name
            }, cookie);
          }

          case 'getLocalStorage': {
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

          case 'setLocalStorage': {
            await executeWithPauseDetection(
              targetCdpManager,
              () => page.evaluate((key: string, value: string) => {
                localStorage.setItem(key, value);
              }, args.key!, args.value!),
              'setLocalStorage'
            );

            return createSuccessResponse('LOCAL_STORAGE_SET_SUCCESS', {
              key: args.key,
              value: args.value
            });
          }

          case 'clear': {
            // Log the reason for audit purposes
            const types = args.types || ['cookies', 'localStorage', 'sessionStorage'];
            console.error(`[cdp-tools] clearStorage called - Reason: ${args.reason}, Types: ${types.join(', ')}, Connection: ${connectionReason || 'default'}`);

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

          default:
            return createErrorResponse('INVALID_ACTION', { action });
        }
      }
    ),
  };
}
