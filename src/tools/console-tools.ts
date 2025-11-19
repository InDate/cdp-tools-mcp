/**
 * Console Monitoring Tools
 */

import { z } from 'zod';
import { PuppeteerManager } from '../puppeteer-manager.js';
import { ConsoleMonitor, StoredConsoleMessage } from '../console-monitor.js';
import { createTool } from '../validation-helpers.js';
import { createSuccessResponse, createErrorResponse, formatCodeBlock } from '../messages.js';

// Zod schemas for console tools
const listConsoleLogsSchema = z.object({
  type: z.string().optional(),
  limit: z.number().default(100),
  offset: z.number().default(0),
  connectionReason: z.string().describe('Connection reference (use the reference from launchChrome output, e.g., "unnamed-connection-default" or your renamed tab)'),
}).strict();

const getConsoleLogSchema = z.object({
  id: z.string(),
  connectionReason: z.string().optional().describe('Connection reference (use the reference from launchChrome output, e.g., "unnamed-connection-default" or your renamed tab)'),
}).strict();

const searchConsoleLogsSchema = z.object({
  pattern: z.string(),
  type: z.string().optional(),
  flags: z.string().default(''),
  limit: z.number().default(50),
  connectionReason: z.string().describe('Connection reference (use the reference from launchChrome output, e.g., "unnamed-connection-default" or your renamed tab)'),
}).strict();

const getRecentConsoleLogsSchema = z.object({
  count: z.number().default(50).describe('Number of recent messages to retrieve'),
  type: z.string().optional().describe('message type filter (log, error, warn, etc.)'),
  connectionReason: z.string().describe('Connection reference (use the reference from launchChrome output, e.g., "unnamed-connection-default" or your renamed tab)'),
}).strict();

const clearConsoleSchema = z.object({
  connectionReason: z.string().optional().describe('Connection reference (use the reference from launchChrome output, e.g., "unnamed-connection-default" or your renamed tab)'),
}).strict();

const emptySchema = z.object({}).strict();

export function createConsoleTools(
  puppeteerManager: PuppeteerManager,
  consoleMonitor: ConsoleMonitor,
  resolveConnectionFromReason: (connectionReason: string) => Promise<any>
) {
  return {
    listConsoleLogs: createTool(
      'List console messages',
      listConsoleLogsSchema,
      async (args) => {
        // Resolve connection from reason
        const resolved = await resolveConnectionFromReason(args.connectionReason);
        if (!resolved) {
          return createErrorResponse('CONNECTION_NOT_FOUND', {
            message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
          });
        }

        const targetPuppeteerManager = resolved.puppeteerManager || puppeteerManager;
        const targetConsoleMonitor = resolved.consoleMonitor || consoleMonitor;

        // Start monitoring if not already active
        if (!targetConsoleMonitor.isActive() && targetPuppeteerManager.isConnected()) {
          const page = targetPuppeteerManager.getPage();
          targetConsoleMonitor.startMonitoring(page);
        }

        const messages = targetConsoleMonitor.getMessages({
          type: args.type,
          limit: args.limit,
          offset: args.offset,
        });

        const messageList = messages.map((msg: StoredConsoleMessage) => ({
          id: msg.id,
          type: msg.type,
          text: msg.text,
          args: msg.args,
          location: msg.location,
          timestamp: msg.timestamp,
        }));

        return createSuccessResponse('CONSOLE_MESSAGES_LIST', {
          count: messages.length,
          totalCount: targetConsoleMonitor.getCount(args.type),
          type: args.type
        }, messageList);
      }
    ),

    getConsoleLog: createTool(
      'Get console message by ID',
      getConsoleLogSchema,
      async (args) => {
        // If connectionReason is provided, resolve connection
        let targetConsoleMonitor = consoleMonitor;
        if (args.connectionReason) {
          const resolved = await resolveConnectionFromReason(args.connectionReason);
          if (!resolved) {
            return createErrorResponse('CONNECTION_NOT_FOUND', {
              message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
            });
          }
          targetConsoleMonitor = resolved.consoleMonitor || consoleMonitor;
        }

        const message = targetConsoleMonitor.getMessage(args.id);

        if (!message) {
          return {
            content: [
              {
                type: 'text',
                text: `## Error\n\nConsole message ${args.id} not found\n\n**Suggestion:** Use \`listConsoleLogs()\` to see all available console messages.`,
              },
            ],
            isError: true,
          };
        }

        const data = {
          id: message.id,
          type: message.type,
          text: message.text,
          args: message.args,
          location: message.location,
          stackTrace: message.stackTrace,
          timestamp: message.timestamp,
        };

        return createSuccessResponse('CONSOLE_MESSAGE_DETAIL', {
          id: message.id,
          type: message.type,
          text: message.text,
          timestamp: message.timestamp
        }, data);
      }
    ),

    getRecentConsoleLogs: createTool(
      'Get recent console messages',
      getRecentConsoleLogsSchema,
      async (args) => {
        // Resolve connection from reason
        const resolved = await resolveConnectionFromReason(args.connectionReason);
        if (!resolved) {
          return createErrorResponse('CONNECTION_NOT_FOUND', {
            message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
          });
        }

        const targetPuppeteerManager = resolved.puppeteerManager || puppeteerManager;
        const targetConsoleMonitor = resolved.consoleMonitor || consoleMonitor;

        // Start monitoring if not already active
        if (!targetConsoleMonitor.isActive() && targetPuppeteerManager.isConnected()) {
          const page = targetPuppeteerManager.getPage();
          targetConsoleMonitor.startMonitoring(page);
        }

        const messages = targetConsoleMonitor.getRecentMessages(args.count, args.type);

        const messageList = messages.map((msg: StoredConsoleMessage) => ({
          id: msg.id,
          type: msg.type,
          text: msg.text,
          args: msg.args,
          location: msg.location,
          timestamp: msg.timestamp,
        }));

        return createSuccessResponse('CONSOLE_MESSAGES_RECENT', {
          count: messages.length,
          requestedCount: args.count,
          totalCount: targetConsoleMonitor.getCount(args.type),
          type: args.type
        }, messageList);
      }
    ),

    searchConsoleLogs: createTool(
      'Search console messages',
      searchConsoleLogsSchema,
      async (args) => {
        // Resolve connection from reason
        const resolved = await resolveConnectionFromReason(args.connectionReason);
        if (!resolved) {
          return createErrorResponse('CONNECTION_NOT_FOUND', {
            message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
          });
        }

        const targetPuppeteerManager = resolved.puppeteerManager || puppeteerManager;
        const targetConsoleMonitor = resolved.consoleMonitor || consoleMonitor;

        // Start monitoring if not already active
        if (!targetConsoleMonitor.isActive() && targetPuppeteerManager.isConnected()) {
          const page = targetPuppeteerManager.getPage();
          targetConsoleMonitor.startMonitoring(page);
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

        // Get all messages and filter
        const allMessages = targetConsoleMonitor.getMessages({ type: args.type });
        const matchingMessages = allMessages
          .filter((msg: StoredConsoleMessage) => regex.test(msg.text))
          .slice(0, args.limit);

        const matches = matchingMessages.map((msg: StoredConsoleMessage) => ({
          id: msg.id,
          type: msg.type,
          text: msg.text,
          args: msg.args,
          location: msg.location,
          timestamp: msg.timestamp,
        }));

        return createSuccessResponse('CONSOLE_SEARCH_RESULTS', {
          pattern: args.pattern,
          flags: args.flags,
          type: args.type,
          matchCount: matchingMessages.length,
          totalSearched: allMessages.length
        }, matches);
      }
    ),

    clearConsole: createTool(
      'Clear console',
      clearConsoleSchema,
      async (args) => {
        let targetConsoleMonitor = consoleMonitor;

        // If connectionReason is provided, resolve the connection
        if (args.connectionReason) {
          const resolved = await resolveConnectionFromReason(args.connectionReason);
          if (!resolved) {
            return createErrorResponse('CONNECTION_NOT_FOUND', {
              message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
            });
          }
          targetConsoleMonitor = resolved.consoleMonitor || consoleMonitor;
        }

        const count = targetConsoleMonitor.getCount();
        targetConsoleMonitor.clear();

        return createSuccessResponse('CONSOLE_CLEARED', { count });
      }
    ),
  };
}
