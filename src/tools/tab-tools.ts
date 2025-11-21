/**
 * Tab Management Tools
 */

import { z } from 'zod';
import type { ConnectionManager } from '../connection-manager.js';
import { CDPManager } from '../cdp-manager.js';
import { PuppeteerManager } from '../puppeteer-manager.js';
import { ConsoleMonitor, type StoredConsoleMessage } from '../console-monitor.js';
import { NetworkMonitor } from '../network-monitor.js';
import { SourceMapHandler } from '../sourcemap-handler.js';
import { createTool } from '../validation-helpers.js';
import { createSuccessResponse, createErrorResponse } from '../messages.js';
import { validateReference, sanitizeReference, UNNAMED_CONNECTION } from '../reference-validator.js';

// Consolidated schema for tab tools
const tabSchema = z.object({
  action: z.enum(['list', 'create', 'rename', 'switch', 'close']).describe('Tab action: list (list all tabs), create (create new tab), rename (rename tab reference), switch (switch to tab), close (close tab)'),
  // Parameters for create action
  reference: z.string().optional().describe('Tab reference (3 descriptive words) - required for create/rename/switch/close actions'),
  url: z.string().optional().describe('URL to navigate to (for create action)'),
  // Parameters for rename action
  newReference: z.string().optional().describe('New reference for tab (3 descriptive words) - required for rename action'),
}).strict();

export function createTabTools(
  connectionManager: ConnectionManager,
  sourceMapHandler: SourceMapHandler,
  updateActiveManagers: (connectionId: string) => void
) {
  return {
    tab: createTool(
      'Manage browser tabs. Actions: list (show all open tabs), create (open new tab with reference), rename (change tab reference), switch (switch active tab), close (close a tab)',
      tabSchema,
      async (args) => {
        const { action } = args;

        // Validate required parameters for each action
        if (action !== 'list' && !args.reference) {
          return createErrorResponse('MISSING_PARAMETER', {
            action,
            missing: 'reference',
            message: `The "${action}" action requires a "reference" parameter`
          });
        }
        if (action === 'rename' && !args.newReference) {
          return createErrorResponse('MISSING_PARAMETER', {
            action: 'rename',
            missing: 'newReference',
            message: 'The "rename" action requires a "newReference" parameter'
          });
        }

        // Handle each action
        switch (action) {
          case 'list': {
            const connections = connectionManager.listConnections();
            const activeId = connectionManager.getActiveConnectionId();

            // Filter to only Chrome connections (tabs)
            const chromeTabs = connections.filter(conn => conn.type === 'chrome');

            if (chromeTabs.length === 0) {
              return {
                content: [{
                  type: 'text',
                  text: '## Open Tabs\n\nNo Chrome tabs currently open.\n\n**Note:** Use action "create" to create a new tab.'
                }]
              };
            }

            // Build tab list with references
            let markdown = '## Open Tabs\n\n';
            markdown += `Total tabs: ${chromeTabs.length}\n\n`;

            for (const conn of chromeTabs) {
              const isActive = conn.id === activeId;
              const activeMarker = isActive ? ' ✓ **ACTIVE**' : '';
              const reference = conn.reference || '*No reference set*';

              // Get page info if available
              let url = 'Unknown';
              let title = 'Unknown';
              try {
                if (conn.puppeteerManager?.isConnected()) {
                  const page = conn.puppeteerManager.getPage();
                  url = page.url();
                  title = await page.title();
                }
              } catch (error) {
                // Ignore errors getting page info
              }

              markdown += `### Tab: ${reference}${activeMarker}\n`;
              markdown += `- **Reference:** ${reference}\n`;
              markdown += `- **URL:** ${url}\n`;
              markdown += `- **Title:** ${title}\n`;
              markdown += `- **Page Index:** ${conn.pageIndex ?? 'Unknown'}\n`;
              markdown += `\n`;
            }

            markdown += '\n**Tip:** Use action "switch" to switch to a different tab, or action "create" to open a new one.';

            return {
              content: [{ type: 'text', text: markdown }],
            };
          }

          case 'create': {
            // Validate reference
            const validation = validateReference(args.reference!);
            if (!validation.valid) {
              return createErrorResponse('INVALID_REFERENCE', {
                error: validation.error!
              });
            }

            // Use the sanitized reference from validation
            const sanitizedReference = validation.sanitized!;

            // Check for duplicate reference
            if (connectionManager.findConnectionByReference(sanitizedReference)) {
              return createErrorResponse('REFERENCE_IN_USE', {
                reference: sanitizedReference
              });
            }

            // Find an existing Chrome connection to get the browser
            const connections = connectionManager.listConnections();
            const chromeConnection = connections.find(conn => conn.type === 'chrome' && conn.puppeteerManager?.isConnected());

            if (!chromeConnection) {
              return createErrorResponse('CONNECTION_NOT_FOUND', {
                message: 'No Chrome browser connected. Use `launchChrome` first to start a browser.'
              });
            }

            try {
              // Create new managers for this tab
              const cdpManager = new CDPManager(sourceMapHandler);
              const puppeteerManager = new PuppeteerManager();
              const consoleMonitor = new ConsoleMonitor();
              const networkMonitor = new NetworkMonitor();

              // Connect to the same browser
              const host = chromeConnection.host;
              const port = chromeConnection.port;

              await cdpManager.connect(host, port);
              await puppeteerManager.connect(host, port);

              // Create new page/tab
              const page = await puppeteerManager.newPage();

              // Start monitoring
              consoleMonitor.startMonitoring(page);
              networkMonitor.startMonitoring(page);

              // Navigate if URL provided
              if (args.url) {
                await page.goto(args.url, { waitUntil: 'load', timeout: 30000 });
              }

              // Get page index
              const pages = await puppeteerManager.getPages();
              const pageIndex = pages.findIndex(p => p === page);

              // Register connection with reference
              const connectionId = connectionManager.createConnection(
                cdpManager,
                puppeteerManager,
                consoleMonitor,
                networkMonitor,
                host,
                port,
                sanitizedReference,
                pageIndex
              );

              // Switch to this new tab as active
              updateActiveManagers(connectionId);

              const url = page.url();
              const title = await page.title();

              // Get console log stats
              const allMessages = consoleMonitor.getMessages({});
              const errorCount = allMessages.filter((m: StoredConsoleMessage) => m.type === 'error').length;
              const warnCount = allMessages.filter((m: StoredConsoleMessage) => m.type === 'warn').length;

              // Format response
              const markdown = `New tab created and connected - Reference: ${args.reference}
Title: ${title}
URL: ${url}
Console: ${allMessages.length} logs (${errorCount} errors, ${warnCount} warnings)`;

              return {
                content: [{ type: 'text', text: markdown }],
              };
            } catch (error) {
              return createErrorResponse('TAB_CREATE_FAILED', {
                error: `${error}`
              });
            }
          }

          case 'rename': {
            // Validate new reference
            const validation = validateReference(args.newReference!);
            if (!validation.valid) {
              return createErrorResponse('INVALID_REFERENCE', {
                error: validation.error!
              });
            }

            // Use the sanitized reference from validation
            const newSanitized = validation.sanitized!;

            // Check if new reference is already in use
            if (connectionManager.findConnectionByReference(newSanitized)) {
              return createErrorResponse('REFERENCE_IN_USE', {
                reference: newSanitized
              });
            }

            // Find connection by reference (sanitize input)
            const sanitizedOldRef = sanitizeReference(args.reference!);
            const connection = connectionManager.findConnectionByReference(sanitizedOldRef);

            if (!connection) {
              return createErrorResponse('CONNECTION_NOT_FOUND', {
                reference: args.reference
              });
            }

            const success = connectionManager.updateReference(connection.id, newSanitized);

            if (success) {
              return createSuccessResponse('TAB_RENAME_SUCCESS', {
                oldReference: args.reference,
                newReference: args.newReference
              });
            } else {
              return createErrorResponse('CONNECTION_NOT_FOUND', {
                reference: args.reference
              });
            }
          }

          case 'switch': {
            // Find connection by reference (sanitize input)
            const sanitizedRef = sanitizeReference(args.reference!);
            const connection = connectionManager.findConnectionByReference(sanitizedRef);

            if (!connection) {
              return createErrorResponse('CONNECTION_NOT_FOUND', {
                reference: args.reference
              });
            }

            const success = connectionManager.setActiveConnection(connection.id);

            if (success) {
              updateActiveManagers(connection.id);

              // Sync Puppeteer page reference to match the connection's page index
              if (connection?.puppeteerManager?.isConnected() && connection.pageIndex !== undefined) {
                try {
                  await connection.puppeteerManager.setPage(connection.pageIndex);
                } catch (error) {
                  // Ignore errors - page might not exist
                }
              }

              // Get current page info
              let url = 'Unknown';
              let title = 'Unknown';
              const reference = connection?.reference || UNNAMED_CONNECTION;

              if (connection?.puppeteerManager?.isConnected()) {
                try {
                  const page = connection.puppeteerManager.getPage();
                  url = page.url();
                  title = await page.title();
                } catch (error) {
                  // Ignore errors
                }
              }

              return createSuccessResponse('TAB_SWITCH_SUCCESS', {
                reference,
                url,
                title
              });
            } else {
              return createErrorResponse('CONNECTION_NOT_FOUND', {
                reference: args.reference
              });
            }
          }

          case 'close': {
            // Find connection by reference (sanitize input)
            const sanitizedRef = sanitizeReference(args.reference!);
            const connection = connectionManager.findConnectionByReference(sanitizedRef);

            if (!connection) {
              return createErrorResponse('CONNECTION_NOT_FOUND', {
                reference: args.reference
              });
            }

            const reference = connection.reference || UNNAMED_CONNECTION;
            const success = await connectionManager.closeConnection(connection.id);

            if (success) {
              // Get info about new active tab
              const newActiveId = connectionManager.getActiveConnectionId();
              const newActive = newActiveId ? connectionManager.getConnection(newActiveId) : null;
              const newActiveReference = newActive?.reference || UNNAMED_CONNECTION;

              return createSuccessResponse('TAB_CLOSE_SUCCESS', {
                closedReference: reference,
                newActiveReference
              });
            } else {
              return createErrorResponse('TAB_CLOSE_FAILED', {
                reference: args.reference
              });
            }
          }

          default:
            return createErrorResponse('INVALID_ACTION', { action });
        }
      }
    ),
  };
}
