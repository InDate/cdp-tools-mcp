/**
 * Console Monitoring Tools
 */

import { z } from 'zod';
import { PuppeteerManager } from '../puppeteer-manager.js';
import { ConsoleMonitor } from '../console-monitor.js';
import { createTool } from '../validation-helpers.js';

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
          .slice(0, args.limit);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                pattern: args.pattern,
                flags: args.flags,
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
      }
    ),

    clearConsole: createTool(
      'Clear console message history',
      emptySchema,
      async () => {
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
      }
    ),
  };
}
