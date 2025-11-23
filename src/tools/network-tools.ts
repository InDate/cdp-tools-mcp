/**
 * Network Analysis Tools
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import { join } from 'path';
import { PuppeteerManager } from '../puppeteer-manager.js';
import { NetworkMonitor, StoredNetworkRequest } from '../network-monitor.js';
import { createTool } from '../validation-helpers.js';
import { createSuccessResponse, createErrorResponse, formatCodeBlock } from '../messages.js';
import type { Page } from 'puppeteer-core';
import { getHomeOutputPath } from '../paths.js';

// Consolidated network tool schema
const networkToolSchema = z.object({
  action: z.enum(['list', 'get', 'search', 'enable', 'disable', 'setConditions'])
    .describe('Network action: list (list network requests), get (get specific request details), search (search requests by pattern), enable (enable network monitoring), disable (disable network monitoring), setConditions (set network conditions)'),
  connectionReason: z.string().optional().describe('Connection reference (use the reference from launchChrome output, e.g., "unnamed-connection-default" or your renamed tab)'),

  // list action parameters
  resourceType: z.string().optional().describe('Filter by resource type (for list and search actions)'),
  limit: z.number().optional().describe('Max results to return (for list action default: 100, for search action default: 50)'),
  offset: z.number().optional().describe('Number of results to skip (for list action, default: 0)'),

  // get action parameters
  id: z.string().optional().describe('Request ID (required for get action)'),
  includeBody: z.boolean().optional().describe('If true, saves response body to disk and returns file path (for get action, default: false)'),

  // search action parameters
  pattern: z.string().optional().describe('Regex pattern to search for (required for search action)'),
  method: z.string().optional().describe('Filter by HTTP method (for search action)'),
  statusCode: z.string().optional().describe('Filter by status code (for search action)'),
  flags: z.string().optional().describe('Regex flags (for search action, default: "")'),

  // setConditions action parameters
  preset: z.enum(['offline', 'slow-3g', 'fast-3g', 'fast-4g', 'online']).optional().describe('Network condition preset (required for setConditions action)'),
}).strict();

export function createNetworkTools(
  puppeteerManager: PuppeteerManager,
  networkMonitor: NetworkMonitor,
  resolveConnectionFromReason: (connectionReason: string) => Promise<any>
) {
  return {
    network: createTool(
      'Monitor and manage network requests. Actions: list (list requests with optional type filter and pagination), get (get specific request by ID), search (search requests by regex pattern), enable (enable network monitoring), disable (disable network monitoring), setConditions (set network throttling conditions)',
      networkToolSchema,
      async (args) => {
        const { action, connectionReason } = args;

        switch (action) {
          case 'list': {
            const { resourceType, limit = 100, offset = 0 } = args;

            if (!connectionReason) {
              return createErrorResponse('CONNECTION_NOT_FOUND', {
                message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
              });
            }

            // Resolve connection from reason
            const resolved = await resolveConnectionFromReason(connectionReason);
            if (!resolved) {
              return createErrorResponse('CONNECTION_NOT_FOUND', {
                message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
              });
            }

            const targetPuppeteerManager = resolved.puppeteerManager || puppeteerManager;
            const targetNetworkMonitor = resolved.networkMonitor || networkMonitor;

            // Start monitoring if not already active
            if (!targetNetworkMonitor.isActive() && targetPuppeteerManager.isConnected()) {
              const page = targetPuppeteerManager.getPage();
              targetNetworkMonitor.startMonitoring(page);
            }

            const requests = targetNetworkMonitor.getRequests({
              resourceType,
              limit,
              offset,
            });

            const requestList = requests.map((req: StoredNetworkRequest) => ({
              id: req.id,
              url: req.url,
              method: req.method,
              resourceType: req.resourceType,
              status: req.response?.status,
              statusText: req.response?.statusText,
              duration: req.timing?.duration,
              failed: req.failed,
              errorText: req.errorText,
            }));

            return createSuccessResponse('NETWORK_REQUESTS_LIST', {
              count: requests.length,
              totalCount: targetNetworkMonitor.getCount(resourceType),
              resourceType
            }, requestList);
          }

          case 'get': {
            const { id, includeBody = false } = args;

            if (!id) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `## Error\n\nMissing required parameter: \`id\`\n\n**Action:** get\n\n**Suggestion:** Provide a request ID from the network requests list.`,
                  },
                ],
                isError: true,
              };
            }

            // If connectionReason is provided, resolve connection
            let targetNetworkMonitor = networkMonitor;
            if (connectionReason) {
              const resolved = await resolveConnectionFromReason(connectionReason);
              if (!resolved) {
                return createErrorResponse('CONNECTION_NOT_FOUND', {
                  message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
                });
              }
              targetNetworkMonitor = resolved.networkMonitor || networkMonitor;
            }

            const request = targetNetworkMonitor.getRequest(id);

            if (!request) {
              return createErrorResponse('NETWORK_REQUEST_NOT_FOUND', { id });
            }

            // Prepare response object, potentially saving body to disk
            let responseData = request.response;
            let bodyPath: string | undefined;

            if (includeBody && request.response?.body) {
              // Save body to disk and return path instead of inline body
              const networkBodiesDir = getHomeOutputPath('network-bodies');
              await fs.mkdir(networkBodiesDir, { recursive: true });

              // Create filename based on request ID and sanitized URL
              const urlParts = new URL(request.url);
              const sanitizedPath = urlParts.pathname.replace(/[^a-zA-Z0-9]/g, '_');
              const filename = `${request.id}_${sanitizedPath}.txt`;
              bodyPath = join(networkBodiesDir, filename);

              await fs.writeFile(bodyPath, request.response.body, 'utf-8');

              // Create response object without the body
              responseData = {
                status: request.response.status,
                statusText: request.response.statusText,
                headers: request.response.headers,
                bodySize: request.response.bodySize,
                bodyTokens: request.response.bodyTokens,
                bodyPath,
              };
            } else if (!includeBody && request.response) {
              // Don't include body in response by default
              responseData = {
                status: request.response.status,
                statusText: request.response.statusText,
                headers: request.response.headers,
                bodySize: request.response.bodySize,
                bodyTokens: request.response.bodyTokens,
              };
            }

            const data = {
              id: request.id,
              url: request.url,
              method: request.method,
              resourceType: request.resourceType,
              requestHeaders: request.requestHeaders,
              postData: request.postData,
              response: responseData,
              timing: request.timing,
              failed: request.failed,
              errorText: request.errorText,
            };

            const metadata: any = {
              id: request.id,
              url: request.url,
              method: request.method,
              resourceType: request.resourceType,
              status: request.response?.status || 'N/A',
              failed: request.failed,
              errorText: request.errorText,
            };

            if (request.response?.bodySize !== undefined) {
              metadata.bodySize = `${request.response.bodySize} characters`;
            }
            if (request.response?.bodyTokens !== undefined) {
              metadata.bodyTokens = `~${request.response.bodyTokens} tokens`;
            }
            if (bodyPath) {
              metadata.bodyPath = bodyPath;
            }

            return createSuccessResponse('NETWORK_REQUEST_DETAIL', metadata, data);
          }

          case 'enable': {
            if (!puppeteerManager.isConnected()) {
              return createErrorResponse('PUPPETEER_NOT_CONNECTED');
            }

            const page = puppeteerManager.getPage();
            networkMonitor.startMonitoring(page);

            return createSuccessResponse('NETWORK_MONITORING_ENABLED');
          }

          case 'disable': {
            if (!puppeteerManager.isConnected()) {
              return createErrorResponse('PUPPETEER_NOT_CONNECTED');
            }

            const page = puppeteerManager.getPage();
            networkMonitor.stopMonitoring(page);

            return createSuccessResponse('NETWORK_MONITORING_DISABLED');
          }

          case 'search': {
            const { pattern, resourceType, method, statusCode, flags = '', limit = 50 } = args;

            if (!pattern) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `## Error\n\nMissing required parameter: \`pattern\`\n\n**Action:** search\n\n**Suggestion:** Provide a regex pattern to search network requests.`,
                  },
                ],
                isError: true,
              };
            }

            if (!connectionReason) {
              return createErrorResponse('CONNECTION_NOT_FOUND', {
                message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
              });
            }

            // Resolve connection from reason
            const resolved = await resolveConnectionFromReason(connectionReason);
            if (!resolved) {
              return createErrorResponse('CONNECTION_NOT_FOUND', {
                message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
              });
            }

            const targetPuppeteerManager = resolved.puppeteerManager || puppeteerManager;
            const targetNetworkMonitor = resolved.networkMonitor || networkMonitor;

            // Start monitoring if not already active
            if (!targetNetworkMonitor.isActive() && targetPuppeteerManager.isConnected()) {
              const page = targetPuppeteerManager.getPage();
              targetNetworkMonitor.startMonitoring(page);
            }

            let regex: RegExp;
            try {
              regex = new RegExp(pattern, flags);
            } catch (error) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `## Error\n\nInvalid regex pattern: ${error}\n\n**Suggestion:** Check your regex syntax and try again.`,
                  },
                ],
                isError: true,
              };
            }

            // Get all requests and filter
            const allRequests = targetNetworkMonitor.getRequests({ resourceType });

            const matchingRequests = allRequests
              .filter((req: StoredNetworkRequest) => {
                // Filter by URL pattern
                if (!regex.test(req.url)) return false;

                // Filter by method if specified
                if (method && req.method !== method.toUpperCase()) return false;

                // Filter by status code if specified
                if (statusCode && req.response) {
                  const status = req.response.status;
                  if (statusCode.endsWith('xx')) {
                    const prefix = statusCode.charAt(0);
                    if (!String(status).startsWith(prefix)) return false;
                  } else if (String(status) !== statusCode) {
                    return false;
                  }
                }

                return true;
              })
              .slice(0, limit);

            const matches = matchingRequests.map((req: StoredNetworkRequest) => ({
              id: req.id,
              url: req.url,
              method: req.method,
              resourceType: req.resourceType,
              status: req.response?.status,
              statusText: req.response?.statusText,
              duration: req.timing?.duration,
              failed: req.failed,
              errorText: req.errorText,
            }));

            const filters = [];
            if (resourceType) filters.push(`Resource Type: ${resourceType}`);
            if (method) filters.push(`Method: ${method}`);
            if (statusCode) filters.push(`Status: ${statusCode}`);

            return createSuccessResponse('NETWORK_SEARCH_RESULTS', {
              pattern,
              flags,
              filtersText: filters.length > 0 ? filters.join(', ') : undefined,
              matchCount: matchingRequests.length,
              totalSearched: allRequests.length
            }, matches);
          }

          case 'setConditions': {
            const { preset } = args;

            if (!preset) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `## Error\n\nMissing required parameter: \`preset\`\n\n**Action:** setConditions\n\n**Suggestion:** Provide a network condition preset (offline, slow-3g, fast-3g, fast-4g, online).`,
                  },
                ],
                isError: true,
              };
            }

            if (!connectionReason) {
              return createErrorResponse('CONNECTION_NOT_FOUND', {
                message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
              });
            }

            // Resolve connection from reason
            const resolved = await resolveConnectionFromReason(connectionReason);
            if (!resolved) {
              return createErrorResponse('CONNECTION_NOT_FOUND', {
                message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
              });
            }

            const targetPuppeteerManager = resolved.puppeteerManager || puppeteerManager;

            if (!targetPuppeteerManager.isConnected()) {
              return createErrorResponse('PUPPETEER_NOT_CONNECTED');
            }

            const page = targetPuppeteerManager.getPage() as Page;
            const cdpSession = await page.createCDPSession();

            const presets: Record<string, any> = {
              'offline': { offline: true, downloadThroughput: 0, uploadThroughput: 0, latency: 0 },
              'slow-3g': { offline: false, downloadThroughput: 50 * 1024 / 8, uploadThroughput: 50 * 1024 / 8, latency: 2000 },
              'fast-3g': { offline: false, downloadThroughput: 1.6 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8, latency: 562.5 },
              'fast-4g': { offline: false, downloadThroughput: 4 * 1024 * 1024 / 8, uploadThroughput: 3 * 1024 * 1024 / 8, latency: 170 },
              'online': { offline: false, downloadThroughput: -1, uploadThroughput: -1, latency: 0 },
            };

            const conditions = presets[preset];
            await cdpSession.send('Network.emulateNetworkConditions', conditions);

            return createSuccessResponse('NETWORK_CONDITIONS_SET', {
              preset
            }, conditions);
          }

          default:
            return {
              content: [
                {
                  type: 'text',
                  text: `## Error\n\nInvalid action: ${action}\n\n**Valid actions:** list, get, search, enable, disable, setConditions`,
                },
              ],
              isError: true,
            };
        }
      }
    ),
  };
}
