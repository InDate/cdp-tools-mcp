/**
 * Server Tools
 * MCP tools for managing npm/node development servers
 */

import { z } from 'zod';
import { createTool } from '../validation-helpers.js';
import { ServerManager, type PackageInfo, type ServerStatus, type LogStats } from '../server-manager.js';
import { createSuccessResponse, createErrorResponse } from '../messages.js';

const serverSchema = z.object({
  action: z.enum(['scan', 'start', 'stop', 'restart', 'list', 'logs', 'stopAll', 'setAutoRun', 'clearLogs'])
    .describe('Server action: scan (find package.json files), start (start a server), stop (stop a server), restart (restart a server), list (list running servers), logs (get server logs), stopAll (stop all servers), setAutoRun (enable/disable auto-start on MCP startup), clearLogs (clear log files for a server)'),
  path: z.string().optional()
    .describe('Directory path to scan for package.json files (for scan action), or package directory path (for start action)'),
  script: z.string().optional()
    .describe('npm script name to run (for start action). Common scripts: dev, start, serve'),
  serverId: z.string().optional()
    .describe('Server ID to operate on (for stop, restart, logs, setAutoRun actions). Format: "package-name:script"'),
  autoRun: z.boolean().optional()
    .describe('Enable auto-run on MCP startup (for setAutoRun action, or when starting a server)'),
  env: z.record(z.string()).optional()
    .describe('Environment variables to set when starting the server (for start action)'),
  logType: z.enum(['stdout', 'stderr', 'all']).optional()
    .describe('Type of logs to retrieve (for logs action, default: all)'),
  lines: z.number().optional()
    .describe('Number of log lines to retrieve (for logs action). If not specified, returns new logs since last view.'),
  maxDepth: z.number().optional()
    .describe('Maximum directory depth to scan (for scan action, default: 5)'),
}).strict();

type ServerArgs = z.infer<typeof serverSchema>;

/**
 * Format log status line for all servers
 */
function formatLogStatusLine(stats: LogStats[]): string {
  if (stats.length === 0) return '';

  const parts = stats.map(s => {
    const hasNew = s.newStderr > 0 || s.newStdout > 0;
    if (!hasNew) return null;
    return `${s.serverId} (${s.newStderr} err/${s.newStdout} out)`;
  }).filter(Boolean);

  if (parts.length === 0) return '';

  return `📊 **Logs:** ${parts.join(' | ')}`;
}

/**
 * Format packages for scan response
 */
function formatPackagesForScan(packages: PackageInfo[]): { serverPackages: string; otherPackages: string; hasServerPackages: boolean; hasOtherPackages: boolean } {
  const withServers = packages.filter(p => p.serverScripts.length > 0);
  const withoutServers = packages.filter(p => p.serverScripts.length === 0);

  let serverPackages = '';
  for (const pkg of withServers) {
    serverPackages += `\n**${pkg.name}** - \`${pkg.path}\`\n`;
    serverPackages += `Scripts: ${pkg.serverScripts.map(s => `\`${s}\``).join(', ')}\n`;
  }

  const otherPackages = withoutServers.map(p => `\`${p.name}\``).join(', ');

  return {
    serverPackages: serverPackages.trim(),
    otherPackages,
    hasServerPackages: withServers.length > 0,
    hasOtherPackages: withoutServers.length > 0,
  };
}

/**
 * Format server list for response
 */
function formatServerList(servers: ServerStatus[]): string {
  let output = '';
  for (const s of servers) {
    const status = s.running ? '🟢' : '🔴';
    const autoRunBadge = s.autoRun ? ' ⚡' : '';
    output += `### ${status} ${s.id}${autoRunBadge}\n`;
    output += `- **Package:** ${s.packageName}\n`;
    output += `- **Script:** \`${s.script}\` → \`${s.command}\`\n`;
    output += `- **PID:** ${s.pid}${s.port ? ` | **Port:** ${s.port}` : ''}\n`;
    output += `- **Uptime:** ${s.uptime}${s.autoRun ? ' | **Auto-run:** enabled' : ''}\n`;
    output += `- **Path:** \`${s.packagePath}\`\n\n`;
  }
  return output.trim();
}

export function createServerTools(serverManager: ServerManager) {
  /**
   * Get status line to append to all responses
   */
  const getLogStatus = (): string => {
    const stats = serverManager.getLogStats();
    return formatLogStatusLine(stats);
  };

  /**
   * Append log status to response variables
   */
  const withLogStatus = (vars: Record<string, any>): Record<string, any> => {
    const logStatus = getLogStatus();
    return { ...vars, logStatus, hasLogStatus: logStatus.length > 0 };
  };

  return {
    server: createTool(
      'Manage npm/node development servers. Actions: scan (find all package.json with server scripts), start (start a server from npm script), stop (stop a running server), restart (restart a server), list (list running servers with status), logs (get server console output), stopAll (stop all servers), setAutoRun (enable/disable auto-start on MCP startup)',
      serverSchema,
      async (args: ServerArgs) => {
        switch (args.action) {
          case 'scan': {
            const scanPath = args.path || process.cwd();
            const maxDepth = args.maxDepth || 5;

            try {
              const packages = await serverManager.scanForPackages(scanPath, maxDepth);
              const formatted = formatPackagesForScan(packages);

              return createSuccessResponse('SERVER_SCAN_SUCCESS', withLogStatus({
                count: packages.length,
                path: scanPath,
                ...formatted,
              }));
            } catch (err) {
              return createErrorResponse('SERVER_START_FAILED', withLogStatus({
                error: err instanceof Error ? err.message : String(err),
              }));
            }
          }

          case 'start': {
            if (!args.path) {
              return createErrorResponse('SERVER_MISSING_PATH', withLogStatus({}));
            }
            if (!args.script) {
              return createErrorResponse('SERVER_MISSING_SCRIPT', withLogStatus({}));
            }

            try {
              const result = await serverManager.startServer(args.path, args.script, {
                autoRun: args.autoRun,
                env: args.env,
              });

              // Wait briefly for port detection
              await new Promise(resolve => setTimeout(resolve, 1500));

              const status = serverManager.getStatus(result.id);
              const serverStatus = status[0];

              return createSuccessResponse('SERVER_START_SUCCESS', withLogStatus({
                id: result.id,
                pid: result.pid,
                port: serverStatus?.port,
                autoRun: serverStatus?.autoRun,
              }));
            } catch (err) {
              return createErrorResponse('SERVER_START_FAILED', withLogStatus({
                error: err instanceof Error ? err.message : String(err),
              }));
            }
          }

          case 'stop': {
            if (!args.serverId) {
              return createErrorResponse('SERVER_MISSING_SERVER_ID', withLogStatus({}));
            }

            try {
              await serverManager.stopServer(args.serverId);
              return createSuccessResponse('SERVER_STOP_SUCCESS', withLogStatus({
                serverId: args.serverId,
              }));
            } catch (err) {
              return createErrorResponse('SERVER_NOT_FOUND', withLogStatus({
                serverId: args.serverId,
              }));
            }
          }

          case 'restart': {
            if (!args.serverId) {
              return createErrorResponse('SERVER_MISSING_SERVER_ID', withLogStatus({}));
            }

            try {
              const result = await serverManager.restartServer(args.serverId);

              // Wait briefly for port detection
              await new Promise(resolve => setTimeout(resolve, 1500));

              const status = serverManager.getStatus(result.id);
              const serverStatus = status[0];

              return createSuccessResponse('SERVER_RESTART_SUCCESS', withLogStatus({
                id: result.id,
                pid: result.pid,
                port: serverStatus?.port,
                autoRun: serverStatus?.autoRun,
              }));
            } catch (err) {
              return createErrorResponse('SERVER_NOT_FOUND', withLogStatus({
                serverId: args.serverId,
              }));
            }
          }

          case 'list': {
            await serverManager.cleanup();
            const servers = serverManager.getStatus();

            if (servers.length === 0) {
              return createSuccessResponse('SERVER_LIST_EMPTY', withLogStatus({}));
            }

            return createSuccessResponse('SERVER_LIST_SUCCESS', withLogStatus({
              count: servers.length,
              serverList: formatServerList(servers),
            }));
          }

          case 'logs': {
            if (!args.serverId) {
              return createErrorResponse('SERVER_MISSING_SERVER_ID', withLogStatus({}));
            }

            try {
              const isDelta = args.lines === undefined;
              const logs = serverManager.getLogs(args.serverId, {
                type: args.logType || 'all',
                lines: args.lines,
                delta: isDelta,
              });

              const status = serverManager.getStatus(args.serverId);
              const serverStatus = status[0];

              if (logs.length === 0) {
                return createSuccessResponse('SERVER_LOGS_EMPTY', withLogStatus({
                  serverId: args.serverId,
                  running: serverStatus?.running,
                  autoRun: serverStatus?.autoRun,
                  isDelta,
                }));
              }

              return createSuccessResponse('SERVER_LOGS_SUCCESS', withLogStatus({
                serverId: args.serverId,
                lineCount: logs.length,
                isDelta,
                running: serverStatus?.running,
                autoRun: serverStatus?.autoRun,
                port: serverStatus?.port,
                uptime: serverStatus?.uptime,
                logs: '```\n' + logs.join('\n') + '\n```',
              }));
            } catch (err) {
              return createErrorResponse('SERVER_NOT_FOUND', withLogStatus({
                serverId: args.serverId,
              }));
            }
          }

          case 'stopAll': {
            const stopped = await serverManager.stopAll();

            if (stopped.length === 0) {
              return createSuccessResponse('SERVER_STOP_ALL_EMPTY', withLogStatus({}));
            }

            return createSuccessResponse('SERVER_STOP_ALL_SUCCESS', withLogStatus({
              count: stopped.length,
              serverIds: stopped.map(id => `\`${id}\``).join(', '),
            }));
          }

          case 'setAutoRun': {
            if (!args.serverId) {
              return createErrorResponse('SERVER_MISSING_SERVER_ID', withLogStatus({}));
            }
            if (args.autoRun === undefined) {
              return createErrorResponse('SERVER_MISSING_AUTORUN', withLogStatus({}));
            }

            try {
              await serverManager.setAutoRun(args.serverId, args.autoRun);

              const messageId = args.autoRun ? 'SERVER_AUTORUN_ENABLED' : 'SERVER_AUTORUN_DISABLED';
              return createSuccessResponse(messageId, withLogStatus({
                serverId: args.serverId,
              }));
            } catch (err) {
              return createErrorResponse('SERVER_NOT_FOUND', withLogStatus({
                serverId: args.serverId,
              }));
            }
          }

          case 'clearLogs': {
            if (!args.serverId) {
              return createErrorResponse('SERVER_MISSING_SERVER_ID', withLogStatus({}));
            }

            try {
              const result = await serverManager.clearLogs(args.serverId);
              return createSuccessResponse('SERVER_LOGS_CLEARED', withLogStatus({
                serverId: args.serverId,
                logDir: result.logDir,
              }));
            } catch (err) {
              return createErrorResponse('SERVER_NOT_FOUND', withLogStatus({
                serverId: args.serverId,
              }));
            }
          }

          default: {
            return createErrorResponse('SERVER_START_FAILED', withLogStatus({
              error: `Unknown action: ${(args as any).action}`,
            }));
          }
        }
      }
    ),
  };
}
