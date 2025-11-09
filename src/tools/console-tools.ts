/**
 * Console Monitoring Tools
 */

import { z } from 'zod';
import { PuppeteerManager } from '../puppeteer-manager.js';
import { ConsoleMonitor } from '../console-monitor.js';
import { createTool } from '../validation-helpers.js';
import { createSuccessResponse, createErrorResponse, formatCodeBlock } from '../messages.js';

// Zod schemas for console tools
const listConsoleLogsSchema = z.object({
  type: z.string().optional(),
  limit: z.number().default(100),
  offset: z.number().default(0),
}).strict();

const getConsoleLogSchema = z.object({
  id: z.string(),
}).strict();

const searchConsoleLogsSchema = z.object({
  pattern: z.string(),
  type: z.string().optional(),
  flags: z.string().default(''),
  limit: z.number().default(50),
}).strict();

const getRecentConsoleLogsSchema = z.object({
  count: z.number().default(50).describe('Number of recent messages to retrieve'),
  type: z.string().optional().describe('Optional message type filter (log, error, warn, etc.)'),
}).strict();

const emptySchema = z.object({}).strict();

export function createConsoleTools(puppeteerManager: PuppeteerManager, consoleMonitor: ConsoleMonitor) {
  return {
    listConsoleLogs: createTool(
      'List console messages with optional type filtering. For searching specific text, use searchConsoleLogs instead.',
      listConsoleLogsSchema,
      async (args) => {
        // Start monitoring if not already active
        if (!consoleMonitor.isActive() && puppeteerManager.isConnected()) {
          const page = puppeteerManager.getPage();
          consoleMonitor.startMonitoring(page);
        }

        const messages = consoleMonitor.getMessages({
          type: args.type,
          limit: args.limit,
          offset: args.offset,
        });

        const messageList = messages.map(msg => ({
          id: msg.id,
          type: msg.type,
          text: msg.text,
          args: msg.args,
          location: msg.location,
          timestamp: msg.timestamp,
        }));

        return createSuccessResponse('CONSOLE_MESSAGES_LIST', {
          count: messages.length,
          totalCount: consoleMonitor.getCount(args.type),
          type: args.type
        }, messageList);
      }
    ),

    getConsoleLog: createTool(
      'Get a specific console message by ID',
      getConsoleLogSchema,
      async (args) => {
        const message = consoleMonitor.getMessage(args.id);

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
      'Get the most recent N console messages (default: 50). More convenient than listConsoleLogs for viewing recent activity.',
      getRecentConsoleLogsSchema,
      async (args) => {
        // Start monitoring if not already active
        if (!consoleMonitor.isActive() && puppeteerManager.isConnected()) {
          const page = puppeteerManager.getPage();
          consoleMonitor.startMonitoring(page);
        }

        const messages = consoleMonitor.getRecentMessages(args.count, args.type);

        const messageList = messages.map(msg => ({
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
          totalCount: consoleMonitor.getCount(args.type),
          type: args.type
        }, messageList);
      }
    ),

    searchConsoleLogs: createTool(
      'Search console messages using regex pattern (more efficient than listConsoleLogs for finding specific messages)',
      searchConsoleLogsSchema,
      async (args) => {
        // Start monitoring if not already active
        if (!consoleMonitor.isActive() && puppeteerManager.isConnected()) {
          const page = puppeteerManager.getPage();
          consoleMonitor.startMonitoring(page);
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
        const allMessages = consoleMonitor.getMessages({ type: args.type });
        const matchingMessages = allMessages
          .filter(msg => regex.test(msg.text))
          .slice(0, args.limit);

        const matches = matchingMessages.map(msg => ({
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
      'Clear console message history',
      emptySchema,
      async () => {
        const count = consoleMonitor.getCount();
        consoleMonitor.clear();

        return createSuccessResponse('CONSOLE_CLEARED', { count });
      }
    ),
  };
}
