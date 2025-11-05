/**
 * Console Monitoring Tools
 */

import { PuppeteerManager } from '../puppeteer-manager.js';
import { ConsoleMonitor } from '../console-monitor.js';

export function createConsoleTools(puppeteerManager: PuppeteerManager, consoleMonitor: ConsoleMonitor) {
  return {
    listConsoleLogs: {
      description: 'List console messages with optional type filtering. For searching specific text, use searchConsoleLogs instead.',
      inputSchema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            description: 'Filter by message type (log, info, warn, error, debug, etc.)',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of messages to return (default: 100)',
          },
          offset: {
            type: 'number',
            description: 'Offset for pagination (default: 0)',
          },
        },
      },
      handler: async (args: any) => {
        // Start monitoring if not already active
        if (!consoleMonitor.isActive() && puppeteerManager.isConnected()) {
          const page = puppeteerManager.getPage();
          consoleMonitor.startMonitoring(page);
        }

        const messages = consoleMonitor.getMessages({
          type: args.type,
          limit: args.limit || 100,
          offset: args.offset || 0,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                messages: messages.map(msg => ({
                  id: msg.id,
                  type: msg.type,
                  text: msg.text,
                  location: msg.location,
                  timestamp: msg.timestamp,
                })),
                count: messages.length,
                totalCount: consoleMonitor.getCount(args.type),
              }, null, 2),
            },
          ],
        };
      },
    },

    getConsoleLog: {
      description: 'Get a specific console message by ID',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'The console message ID',
          },
        },
        required: ['id'],
      },
      handler: async (args: any) => {
        const message = consoleMonitor.getMessage(args.id);

        if (!message) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: `Console message ${args.id} not found`,
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
                message: {
                  id: message.id,
                  type: message.type,
                  text: message.text,
                  args: message.args,
                  location: message.location,
                  stackTrace: message.stackTrace,
                  timestamp: message.timestamp,
                },
              }, null, 2),
            },
          ],
        };
      },
    },

    searchConsoleLogs: {
      description: 'Search console messages using regex pattern (more efficient than listConsoleLogs for finding specific messages)',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Regex pattern to search in log text',
          },
          type: {
            type: 'string',
            description: 'Filter by message type (log, info, warn, error, debug, etc.)',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of matching messages to return (default: 50)',
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
        if (!consoleMonitor.isActive() && puppeteerManager.isConnected()) {
          const page = puppeteerManager.getPage();
          consoleMonitor.startMonitoring(page);
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

        // Get all messages and filter
        const allMessages = consoleMonitor.getMessages({ type: args.type });
        const matchingMessages = allMessages
          .filter(msg => regex.test(msg.text))
          .slice(0, limit);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                pattern: args.pattern,
                flags,
                matches: matchingMessages.map(msg => ({
                  id: msg.id,
                  type: msg.type,
                  text: msg.text,
                  location: msg.location,
                  timestamp: msg.timestamp,
                })),
                matchCount: matchingMessages.length,
                totalSearched: allMessages.length,
              }, null, 2),
            },
          ],
        };
      },
    },

    clearConsole: {
      description: 'Clear console message history',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async () => {
        consoleMonitor.clear();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'Console history cleared',
              }, null, 2),
            },
          ],
        };
      },
    },
  };
}
