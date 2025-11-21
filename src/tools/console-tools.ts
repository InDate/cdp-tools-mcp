/**
 * Console Monitoring Tools
 */

import { z } from 'zod';
import { PuppeteerManager } from '../puppeteer-manager.js';
import { ConsoleMonitor, StoredConsoleMessage } from '../console-monitor.js';
import { createTool } from '../validation-helpers.js';
import { createSuccessResponse, createErrorResponse, formatCodeBlock } from '../messages.js';

// Consolidated schema for console tools
const consoleSchema = z.object({
  action: z.enum(['list', 'get', 'recent', 'search', 'clear']).describe('Console action: list (list messages), get (get by ID), recent (get recent messages), search (search by pattern), clear (clear console)'),
  connectionReason: z.string().describe('Connection reference (use the reference from launchChrome output, e.g., "unnamed-connection-default" or your renamed tab)'),
  // Parameters for 'list' action
  type: z.string().optional().describe('Message type filter (log, error, warn, etc.)'),
  limit: z.number().optional().describe('Maximum number of messages to return (default: 100 for list, 50 for search/recent)'),
  offset: z.number().optional().describe('Number of messages to skip (for list action, default: 0)'),
  // Parameters for 'get' action
  id: z.string().optional().describe('Console message ID (required for get action)'),
  // Parameters for 'search' action
  pattern: z.string().optional().describe('Regex pattern to search for (required for search action)'),
  flags: z.string().optional().describe('Regex flags (for search action, default: "")'),
  // Parameters for 'recent' action
  count: z.number().optional().describe('Number of recent messages to retrieve (for recent action, default: 50)'),
  // Parameters for 'clear' action
  reason: z.string().optional().describe('Why the console needs to be cleared (required for clear action)'),
}).strict();

export function createConsoleTools(
  puppeteerManager: PuppeteerManager,
  consoleMonitor: ConsoleMonitor,
  resolveConnectionFromReason: (connectionReason: string) => Promise<any>
) {
  return {
    console: createTool(
      'Monitor and manage console messages. Actions: list (list messages with optional type filter and pagination), get (get specific message by ID), recent (get N most recent messages), search (search messages by regex pattern), clear (clear all console messages)',
      consoleSchema,
      async (args) => {
        const { action, connectionReason } = args;

        // Validate required parameters for each action
        if (action === 'get' && !args.id) {
          return createErrorResponse('MISSING_PARAMETER', {
            action: 'get',
            missing: 'id',
            message: 'The "get" action requires an "id" parameter'
          });
        }
        if (action === 'search' && !args.pattern) {
          return createErrorResponse('MISSING_PARAMETER', {
            action: 'search',
            missing: 'pattern',
            message: 'The "search" action requires a "pattern" parameter'
          });
        }
        if (action === 'clear' && !args.reason) {
          return createErrorResponse('MISSING_PARAMETER', {
            action: 'clear',
            missing: 'reason',
            message: 'The "clear" action requires a "reason" parameter'
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
        const targetConsoleMonitor = resolved.consoleMonitor || consoleMonitor;

        // Handle each action
        switch (action) {
          case 'list': {
            // Start monitoring if not already active
            if (!targetConsoleMonitor.isActive() && targetPuppeteerManager.isConnected()) {
              const page = targetPuppeteerManager.getPage();
              targetConsoleMonitor.startMonitoring(page);
            }

            const messages = targetConsoleMonitor.getMessages({
              type: args.type,
              limit: args.limit ?? 100,
              offset: args.offset ?? 0,
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

          case 'get': {
            const message = targetConsoleMonitor.getMessage(args.id!);

            if (!message) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `## Error\n\nConsole message ${args.id} not found\n\n**Suggestion:** Use action "list" to see all available console messages.`,
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

          case 'recent': {
            // Start monitoring if not already active
            if (!targetConsoleMonitor.isActive() && targetPuppeteerManager.isConnected()) {
              const page = targetPuppeteerManager.getPage();
              targetConsoleMonitor.startMonitoring(page);
            }

            const messages = targetConsoleMonitor.getRecentMessages(args.count ?? 50, args.type);

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
              requestedCount: args.count ?? 50,
              totalCount: targetConsoleMonitor.getCount(args.type),
              type: args.type
            }, messageList);
          }

          case 'search': {
            // Start monitoring if not already active
            if (!targetConsoleMonitor.isActive() && targetPuppeteerManager.isConnected()) {
              const page = targetPuppeteerManager.getPage();
              targetConsoleMonitor.startMonitoring(page);
            }

            let regex: RegExp;
            try {
              regex = new RegExp(args.pattern!, args.flags ?? '');
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
              .slice(0, args.limit ?? 50);

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
              flags: args.flags ?? '',
              type: args.type,
              matchCount: matchingMessages.length,
              totalSearched: allMessages.length
            }, matches);
          }

          case 'clear': {
            // Log the reason for audit purposes
            console.error(`[cdp-tools] clearConsole called - Reason: ${args.reason}, Connection: ${connectionReason}`);

            const count = targetConsoleMonitor.getCount();
            targetConsoleMonitor.clear();

            return createSuccessResponse('CONSOLE_CLEARED', { count });
          }

          default:
            return createErrorResponse('INVALID_ACTION', { action });
        }
      }
    ),
  };
}
