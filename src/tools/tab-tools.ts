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

export function createTabTools(
  connectionManager: ConnectionManager,
  sourceMapHandler: SourceMapHandler,
  updateActiveManagers: (connectionId: string) => void
) {
  return {
    listTabs: createTool(
      'List all open tabs with their references, URLs, and connection details',
      z.object({}).strict(),
      async () => {
        const connections = connectionManager.listConnections();
        const activeId = connectionManager.getActiveConnectionId();

        // Filter to only Chrome connections (tabs)
        const chromeTabs = connections.filter(conn => conn.type === 'chrome');

        if (chromeTabs.length === 0) {
          return {
            content: [{
              type: 'text',
              text: '## Open Tabs\n\nNo Chrome tabs currently open.\n\n**Note:** Use `launchChrome` or `connectDebugger` to create a new tab.'
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
          markdown += `- **Connection ID:** ${conn.id}\n`;
          markdown += `- **Reference:** ${reference}\n`;
          markdown += `- **URL:** ${url}\n`;
          markdown += `- **Title:** ${title}\n`;
          markdown += `- **Page Index:** ${conn.pageIndex ?? 'Unknown'}\n`;
          markdown += `\n`;
        }

        markdown += '\n**Tip:** Use `switchTab(connectionId)` to switch to a different tab, or `createTab(reference)` to open a new one.';

        return {
          content: [{ type: 'text', text: markdown }],
        };
      }
    ),

    createTab: createTool(
      'Create a new tab in the browser with a required reference name',
      z.object({
        reference: z.string().describe('Required reference name for this tab (e.g., "agent1-search", "product-details")'),
        url: z.string().optional().describe('Optional URL to navigate to in the new tab'),
      }).strict(),
      async (args) => {
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
            args.reference,
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
Console: ${allMessages.length} logs (${errorCount} errors, ${warnCount} warnings)

**TIP:** Browser tools now use \`connectionReason\` instead of connectionId. Use 3 descriptive words like "search wikipedia results" or "${args.reference}" to automatically create/reuse this tab.`;

          return {
            content: [{ type: 'text', text: markdown }],
          };
        } catch (error) {
          return createErrorResponse('TAB_CREATE_FAILED', {
            error: `${error}`
          });
        }
      }
    ),

    renameTab: createTool(
      'Rename/update the reference for a tab',
      z.object({
        connectionId: z.string().describe('The connection ID of the tab to rename'),
        newReference: z.string().describe('The new reference name for the tab'),
      }).strict(),
      async (args) => {
        const success = connectionManager.updateReference(args.connectionId, args.newReference);

        if (success) {
          return createSuccessResponse('TAB_RENAME_SUCCESS', {
            connectionId: args.connectionId,
            newReference: args.newReference
          });
        } else {
          return createErrorResponse('CONNECTION_NOT_FOUND', {
            connectionId: args.connectionId
          });
        }
      }
    ),

    switchTab: createTool(
      'Switch the active tab to a different connection',
      z.object({
        connectionId: z.string().describe('The connection ID of the tab to switch to'),
      }).strict(),
      async (args) => {
        const success = connectionManager.setActiveConnection(args.connectionId);

        if (success) {
          updateActiveManagers(args.connectionId);
          const connection = connectionManager.getConnection(args.connectionId);

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
          let reference = connection?.reference || 'No reference';

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
            connectionId: args.connectionId,
            reference,
            url,
            title
          });
        } else {
          return createErrorResponse('CONNECTION_NOT_FOUND', {
            connectionId: args.connectionId
          });
        }
      }
    ),

    closeTab: createTool(
      'Close a specific tab',
      z.object({
        connectionId: z.string().describe('The connection ID of the tab to close'),
      }).strict(),
      async (args) => {
        const connection = connectionManager.getConnection(args.connectionId);
        if (!connection) {
          return createErrorResponse('CONNECTION_NOT_FOUND', {
            connectionId: args.connectionId
          });
        }

        const reference = connection.reference || 'Unknown';
        const success = await connectionManager.closeConnection(args.connectionId);

        if (success) {
          // Get info about new active tab
          const newActiveId = connectionManager.getActiveConnectionId();
          const newActive = newActiveId ? connectionManager.getConnection(newActiveId) : null;
          const newActiveReference = newActive?.reference || 'None';

          return createSuccessResponse('TAB_CLOSE_SUCCESS', {
            closedConnectionId: args.connectionId,
            closedReference: reference,
            newActiveConnectionId: newActiveId || 'none',
            newActiveReference
          });
        } else {
          return createErrorResponse('TAB_CLOSE_FAILED', {
            connectionId: args.connectionId
          });
        }
      }
    ),
  };
}
