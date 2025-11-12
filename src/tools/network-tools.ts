/**
 * Network Analysis Tools
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { PuppeteerManager } from '../puppeteer-manager.js';
import { NetworkMonitor, StoredNetworkRequest } from '../network-monitor.js';
import { createTool } from '../validation-helpers.js';
import { createSuccessResponse, createErrorResponse, formatCodeBlock } from '../messages.js';
import type { Page } from 'puppeteer-core';

// Zod schemas for network tools
const listNetworkRequestsSchema = z.object({
  resourceType: z.string().optional(),
  limit: z.number().default(100),
  offset: z.number().default(0),
  connectionReason: z.string().describe('Brief reason for needing this browser connection (3 descriptive words recommended). Auto-creates/reuses tabs.'),
}).strict();

const getNetworkRequestSchema = z.object({
  id: z.string(),
  includeBody: z.boolean().default(false).describe('If true, saves the response body to disk and returns the file path instead of including it inline'),
  connectionReason: z.string().optional().describe('Brief reason for needing this browser connection (3 descriptive words recommended). Auto-creates/reuses tabs.'),
}).strict();

const searchNetworkRequestsSchema = z.object({
  pattern: z.string(),
  resourceType: z.string().optional(),
  method: z.string().optional(),
  statusCode: z.string().optional(),
  flags: z.string().default(''),
  limit: z.number().default(50),
  connectionReason: z.string().describe('Brief reason for needing this browser connection (3 descriptive words recommended). Auto-creates/reuses tabs.'),
}).strict();

const setNetworkConditionsSchema = z.object({
  preset: z.enum(['offline', 'slow-3g', 'fast-3g', 'fast-4g', 'online']),
  connectionReason: z.string().describe('Brief reason for needing this browser connection (3 descriptive words recommended). Auto-creates/reuses tabs.'),
}).strict();

const emptySchema = z.object({}).strict();

export function createNetworkTools(
  puppeteerManager: PuppeteerManager,
  networkMonitor: NetworkMonitor,
  resolveConnectionFromReason: (connectionReason: string) => Promise<any>
) {
  return {
    listNetworkRequests: createTool(
      'List network requests with optional resource type filtering. For searching specific URLs, use searchNetworkRequests instead.',
      listNetworkRequestsSchema,
      async (args) => {
        // Resolve connection from reason
        const resolved = await resolveConnectionFromReason(args.connectionReason);
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
          resourceType: args.resourceType,
          limit: args.limit,
          offset: args.offset,
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
          totalCount: targetNetworkMonitor.getCount(args.resourceType),
          resourceType: args.resourceType
        }, requestList);
      }
    ),

    getNetworkRequest: createTool(
      'Get detailed information about a specific network request. By default, returns metadata including bodySize and bodyTokens WITHOUT the response body to avoid token overflow. Set includeBody=true to save the body to disk and get a file path.',
      getNetworkRequestSchema,
      async (args) => {
        // If connectionReason is provided, resolve connection
        let targetNetworkMonitor = networkMonitor;
        if (args.connectionReason) {
          const resolved = await resolveConnectionFromReason(args.connectionReason);
          if (!resolved) {
            return createErrorResponse('CONNECTION_NOT_FOUND', {
              message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
            });
          }
          targetNetworkMonitor = resolved.networkMonitor || networkMonitor;
        }

        const request = targetNetworkMonitor.getRequest(args.id);

        if (!request) {
          return createErrorResponse('NETWORK_REQUEST_NOT_FOUND', { id: args.id });
        }

        // Prepare response object, potentially saving body to disk
        let responseData = request.response;
        let bodyPath: string | undefined;

        if (args.includeBody && request.response?.body) {
          // Save body to disk and return path instead of inline body
          const networkBodiesDir = join(homedir(), '.claude', 'network-bodies');
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
        } else if (!args.includeBody && request.response) {
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
        // Resolve connection from reason
        const resolved = await resolveConnectionFromReason(args.connectionReason);
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
        const allRequests = targetNetworkMonitor.getRequests({ resourceType: args.resourceType });

        const matchingRequests = allRequests
          .filter((req: StoredNetworkRequest) => {
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
        // Resolve connection from reason
        const resolved = await resolveConnectionFromReason(args.connectionReason);
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

        const conditions = presets[args.preset];
        await cdpSession.send('Network.emulateNetworkConditions', conditions);

        return createSuccessResponse('NETWORK_CONDITIONS_SET', {
          preset: args.preset
        }, conditions);
      }
    ),
  };
}
