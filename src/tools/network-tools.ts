/**
 * Network Analysis Tools
 */

import { PuppeteerManager } from '../puppeteer-manager.js';
import { NetworkMonitor } from '../network-monitor.js';
import type { Page } from 'puppeteer-core';

export function createNetworkTools(puppeteerManager: PuppeteerManager, networkMonitor: NetworkMonitor) {
  return {
    listNetworkRequests: {
      description: 'List network requests with optional resource type filtering. For searching specific URLs, use searchNetworkRequests instead.',
      inputSchema: {
        type: 'object',
        properties: {
          resourceType: {
            type: 'string',
            description: 'Filter by resource type (document, stylesheet, image, media, font, script, xhr, fetch, etc.)',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of requests to return (default: 100)',
          },
          offset: {
            type: 'number',
            description: 'Offset for pagination (default: 0)',
          },
        },
      },
      handler: async (args: any) => {
        // Start monitoring if not already active
        if (!networkMonitor.isActive() && puppeteerManager.isConnected()) {
          const page = puppeteerManager.getPage();
          networkMonitor.startMonitoring(page);
        }

        const requests = networkMonitor.getRequests({
          resourceType: args.resourceType,
          limit: args.limit || 100,
          offset: args.offset || 0,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                requests: requests.map(req => ({
                  id: req.id,
                  url: req.url,
                  method: req.method,
                  resourceType: req.resourceType,
                  status: req.response?.status,
                  statusText: req.response?.statusText,
                  duration: req.timing?.duration,
                  failed: req.failed,
                  errorText: req.errorText,
                })),
                count: requests.length,
                totalCount: networkMonitor.getCount(args.resourceType),
              }, null, 2),
            },
          ],
        };
      },
    },

    getNetworkRequest: {
      description: 'Get detailed information about a specific network request',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'The network request ID',
          },
        },
        required: ['id'],
      },
      handler: async (args: any) => {
        const request = networkMonitor.getRequest(args.id);

        if (!request) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: `Network request ${args.id} not found`,
                }, null, 2),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                request: {
                  id: request.id,
                  url: request.url,
                  method: request.method,
                  resourceType: request.resourceType,
                  requestHeaders: request.requestHeaders,
                  postData: request.postData,
                  response: request.response,
                  timing: request.timing,
                  failed: request.failed,
                  errorText: request.errorText,
                },
              }, null, 2),
            },
          ],
        };
      },
    },

    enableNetworkMonitoring: {
      description: 'Start capturing network traffic',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async () => {
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
        networkMonitor.startMonitoring(page);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'Network monitoring enabled',
              }, null, 2),
            },
          ],
        };
      },
    },

    disableNetworkMonitoring: {
      description: 'Stop capturing network traffic',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async () => {
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
        networkMonitor.stopMonitoring(page);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'Network monitoring disabled',
              }, null, 2),
            },
          ],
        };
      },
    },

    searchNetworkRequests: {
      description: 'Search network requests using regex pattern (more efficient than listNetworkRequests for finding specific requests)',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Regex pattern to search in URL',
          },
          resourceType: {
            type: 'string',
            description: 'Filter by resource type (document, stylesheet, image, media, font, script, xhr, fetch, etc.)',
          },
          method: {
            type: 'string',
            description: 'Filter by HTTP method (GET, POST, PUT, DELETE, etc.)',
          },
          statusCode: {
            type: 'string',
            description: 'Filter by status code (e.g., "200", "4xx", "5xx")',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of matching requests to return (default: 50)',
          },
          flags: {
            type: 'string',
            description: 'Regex flags (e.g., "i" for case-insensitive, default: "")',
          },
        },
        required: ['pattern'],
      },
      handler: async (args: any) => {
        // Start monitoring if not already active
        if (!networkMonitor.isActive() && puppeteerManager.isConnected()) {
          const page = puppeteerManager.getPage();
          networkMonitor.startMonitoring(page);
        }

        const limit = args.limit || 50;
        const flags = args.flags || '';

        let regex: RegExp;
        try {
          regex = new RegExp(args.pattern, flags);
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: `Invalid regex pattern: ${error}`,
                }, null, 2),
              },
            ],
          };
        }

        // Get all requests and filter
        const allRequests = networkMonitor.getRequests({ resourceType: args.resourceType });

        const matchingRequests = allRequests
          .filter(req => {
            // Filter by URL pattern
            if (!regex.test(req.url)) return false;

            // Filter by method if specified
            if (args.method && req.method !== args.method.toUpperCase()) return false;

            // Filter by status code if specified
            if (args.statusCode && req.response) {
              const status = req.response.status;
              if (args.statusCode.endsWith('xx')) {
                const prefix = args.statusCode.charAt(0);
                if (!String(status).startsWith(prefix)) return false;
              } else if (String(status) !== args.statusCode) {
                return false;
              }
            }

            return true;
          })
          .slice(0, limit);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                pattern: args.pattern,
                flags,
                filters: {
                  resourceType: args.resourceType,
                  method: args.method,
                  statusCode: args.statusCode,
                },
                matches: matchingRequests.map(req => ({
                  id: req.id,
                  url: req.url,
                  method: req.method,
                  resourceType: req.resourceType,
                  status: req.response?.status,
                  statusText: req.response?.statusText,
                  duration: req.timing?.duration,
                  failed: req.failed,
                  errorText: req.errorText,
                })),
                matchCount: matchingRequests.length,
                totalSearched: allRequests.length,
              }, null, 2),
            },
          ],
        };
      },
    },

    setNetworkConditions: {
      description: 'Emulate network conditions (throttling)',
      inputSchema: {
        type: 'object',
        properties: {
          preset: {
            type: 'string',
            description: 'Network preset: offline, slow-3g, fast-3g, fast-4g, online (default)',
            enum: ['offline', 'slow-3g', 'fast-3g', 'fast-4g', 'online'],
          },
        },
        required: ['preset'],
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

        const page = puppeteerManager.getPage() as Page;
        const cdpSession = await page.createCDPSession();

        const presets: Record<string, any> = {
          'offline': { offline: true, downloadThroughput: 0, uploadThroughput: 0, latency: 0 },
          'slow-3g': { offline: false, downloadThroughput: 50 * 1024 / 8, uploadThroughput: 50 * 1024 / 8, latency: 2000 },
          'fast-3g': { offline: false, downloadThroughput: 1.6 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8, latency: 562.5 },
          'fast-4g': { offline: false, downloadThroughput: 4 * 1024 * 1024 / 8, uploadThroughput: 3 * 1024 * 1024 / 8, latency: 170 },
          'online': { offline: false, downloadThroughput: -1, uploadThroughput: -1, latency: 0 },
        };

        const conditions = presets[args.preset];
        await cdpSession.send('Network.emulateNetworkConditions', conditions);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: `Network conditions set to ${args.preset}`,
                conditions,
              }, null, 2),
            },
          ],
        };
      },
    },
  };
}
