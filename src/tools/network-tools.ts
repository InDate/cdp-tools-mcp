/**
 * Network Analysis Tools
 */

import { z } from 'zod';
import { PuppeteerManager } from '../puppeteer-manager.js';
import { NetworkMonitor } from '../network-monitor.js';
import { createTool } from '../validation-helpers.js';
import { createSuccessResponse, createErrorResponse, formatCodeBlock } from '../messages.js';
import type { Page } from 'puppeteer-core';

// Zod schemas for network tools
const listNetworkRequestsSchema = z.object({
  resourceType: z.string().optional(),
  limit: z.number().default(100),
  offset: z.number().default(0),
}).strict();

const getNetworkRequestSchema = z.object({
  id: z.string(),
}).strict();

const searchNetworkRequestsSchema = z.object({
  pattern: z.string(),
  resourceType: z.string().optional(),
  method: z.string().optional(),
  statusCode: z.string().optional(),
  flags: z.string().default(''),
  limit: z.number().default(50),
}).strict();

const setNetworkConditionsSchema = z.object({
  preset: z.enum(['offline', 'slow-3g', 'fast-3g', 'fast-4g', 'online']),
}).strict();

const emptySchema = z.object({}).strict();

export function createNetworkTools(puppeteerManager: PuppeteerManager, networkMonitor: NetworkMonitor) {
  return {
    listNetworkRequests: createTool(
      'List network requests with optional resource type filtering. For searching specific URLs, use searchNetworkRequests instead.',
      listNetworkRequestsSchema,
      async (args) => {
        // Start monitoring if not already active
        if (!networkMonitor.isActive() && puppeteerManager.isConnected()) {
          const page = puppeteerManager.getPage();
          networkMonitor.startMonitoring(page);
        }

        const requests = networkMonitor.getRequests({
          resourceType: args.resourceType,
          limit: args.limit,
          offset: args.offset,
        });

        const requestList = requests.map(req => ({
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
          totalCount: networkMonitor.getCount(args.resourceType),
          resourceType: args.resourceType
        }, requestList);
      }
    ),

    getNetworkRequest: createTool(
      'Get detailed information about a specific network request',
      getNetworkRequestSchema,
      async (args) => {
        const request = networkMonitor.getRequest(args.id);

        if (!request) {
          return createErrorResponse('NETWORK_REQUEST_NOT_FOUND', { id: args.id });
        }

        const data = {
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
        };

        return createSuccessResponse('NETWORK_REQUEST_DETAIL', {
          id: request.id,
          url: request.url,
          method: request.method,
          resourceType: request.resourceType,
          status: request.response?.status || 'N/A',
          failed: request.failed,
          errorText: request.errorText
        }, data);
      }
    ),

    enableNetworkMonitoring: createTool(
      'Start capturing network traffic',
      emptySchema,
      async () => {
        if (!puppeteerManager.isConnected()) {
          return createErrorResponse('PUPPETEER_NOT_CONNECTED');
        }

        const page = puppeteerManager.getPage();
        networkMonitor.startMonitoring(page);

        return createSuccessResponse('NETWORK_MONITORING_ENABLED');
      }
    ),

    disableNetworkMonitoring: createTool(
      'Stop capturing network traffic',
      emptySchema,
      async () => {
        if (!puppeteerManager.isConnected()) {
          return createErrorResponse('PUPPETEER_NOT_CONNECTED');
        }

        const page = puppeteerManager.getPage();
        networkMonitor.stopMonitoring(page);

        return createSuccessResponse('NETWORK_MONITORING_DISABLED');
      }
    ),

    searchNetworkRequests: createTool(
      'Search network requests using regex pattern (more efficient than listNetworkRequests for finding specific requests)',
      searchNetworkRequestsSchema,
      async (args) => {
        // Start monitoring if not already active
        if (!networkMonitor.isActive() && puppeteerManager.isConnected()) {
          const page = puppeteerManager.getPage();
          networkMonitor.startMonitoring(page);
        }

        let regex: RegExp;
        try {
          regex = new RegExp(args.pattern, args.flags);
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
          .slice(0, args.limit);

        const matches = matchingRequests.map(req => ({
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
        if (args.resourceType) filters.push(`Resource Type: ${args.resourceType}`);
        if (args.method) filters.push(`Method: ${args.method}`);
        if (args.statusCode) filters.push(`Status: ${args.statusCode}`);

        return createSuccessResponse('NETWORK_SEARCH_RESULTS', {
          pattern: args.pattern,
          flags: args.flags,
          filtersText: filters.length > 0 ? filters.join(', ') : undefined,
          matchCount: matchingRequests.length,
          totalSearched: allRequests.length
        }, matches);
      }
    ),

    setNetworkConditions: createTool(
      'Emulate network conditions (throttling)',
      setNetworkConditionsSchema,
      async (args) => {
        if (!puppeteerManager.isConnected()) {
          return createErrorResponse('PUPPETEER_NOT_CONNECTED');
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

        return createSuccessResponse('NETWORK_CONDITIONS_SET', {
          preset: args.preset
        }, conditions);
      }
    ),
  };
}
