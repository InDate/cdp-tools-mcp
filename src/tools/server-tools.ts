/**
 * Server Tools
 * MCP tools for managing development servers (any language/framework)
 */

import { z } from 'zod';
import { createTool } from '../validation-helpers.js';
import { ServerManager, type ServerStatus, type LogStats, type MonitoredPortStatus, type MonitoringLevel } from '../server-manager.js';
import { type RunnerType } from '../runners/index.js';
import { createSuccessResponse, createErrorResponse } from '../messages.js';

const serverSchema = z.object({
  action: z.enum(['start', 'stop', 'restart', 'list', 'logs', 'stopAll', 'setAutoRun', 'clearLogs', 'remove', 'monitorPort', 'unmonitorPort', 'listMonitored', 'acknowledgePort'])
    .describe('Server action: start (start a server), stop (stop a server), restart (restart a server), list (list servers), logs (get server logs), stopAll (stop all servers), setAutoRun (enable/disable auto-start on MCP startup), clearLogs (clear log files for a server), remove (remove server from config), monitorPort (start monitoring a port), unmonitorPort (stop monitoring a port), listMonitored (list monitored ports), acknowledgePort (acknowledge a port failure)'),
  command: z.string().optional()
    .describe('Command to run (for start action). Examples: "npm run dev", "flask run", "docker run -p 3000:3000 myimage", "docker compose up"'),
  cwd: z.string().optional()
    .describe('Working directory for the command (for start action)'),
  id: z.string().optional()
    .describe('Server identifier (for start action). Use a descriptive name like "flask-api" or "next-frontend"'),
  serverId: z.string().optional()
    .describe('Server ID to operate on (for stop, restart, logs, setAutoRun, clearLogs actions)'),
  autoRun: z.boolean().optional()
    .describe('Enable auto-run on MCP startup (for setAutoRun action, or when starting a server)'),
  env: z.record(z.string()).optional()
    .describe('Environment variables to set when starting the server (for start action)'),
  logType: z.enum(['stdout', 'stderr', 'all']).optional()
    .describe('Type of logs to retrieve (for logs action, default: all)'),
  lines: z.number().optional()
    .describe('Number of log lines to retrieve (for logs action). If not specified, returns new logs since last view.'),
  // Runner type parameter
  runner: z.enum(['native', 'docker', 'docker-compose']).optional()
    .describe('Runner type (for start action): native (spawn process directly), docker (run container), docker-compose (run compose stack). Auto-detected from command if not specified.'),
  // Server port monitoring
  monitorPort: z.boolean().optional()
    .describe('If true, auto-add server port to monitoredPorts when detected (for start action)'),
  // Port monitoring parameters
  port: z.number().optional()
    .describe('Port number (for monitorPort, unmonitorPort, acknowledgePort actions)'),
  monitoringLevel: z.enum(['inform', 'error', 'block']).optional()
    .describe('Monitoring level (for monitorPort action): inform (info line in responses), error (error line in responses), block (block all tools until acknowledged)'),
  description: z.string().optional()
    .describe('Description for the monitored port (for monitorPort action)'),
  interval: z.number().optional()
    .describe('Custom check interval in milliseconds (for monitorPort action). Overrides level-based defaults from config. Default: block=1000ms, error=2000ms, inform=5000ms'),
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
 * Format server list for response
 */
function formatServerList(servers: ServerStatus[]): string {
  let output = '';
  for (const s of servers) {
    const status = s.running ? '🟢' : '🔴';
    const autoRunBadge = s.autoRun ? ' ⚡' : '';
    const runnerBadge = s.runnerType !== 'native' ? ` 🐳` : '';
    output += `### ${status} ${s.id}${autoRunBadge}${runnerBadge}\n`;
    output += `- **Command:** \`${s.command}\`\n`;
    output += `- **CWD:** \`${s.cwd}\`\n`;
    output += `- **Runner:** ${s.runnerType}`;
    if (s.runnerType === 'native') {
      output += ` | **PID:** ${s.pid}`;
    } else if (s.containerId) {
      output += ` | **Container:** ${s.containerId}`;
    }
    if (s.port) {
      output += ` | **Port:** ${s.port}`;
    }
    output += '\n';
    output += `- **Uptime:** ${s.uptime}${s.autoRun ? ' | **Auto-run:** enabled' : ''}\n\n`;
  }
  return output.trim();
}

/**
 * Format monitored ports list for response
 */
function formatMonitoredPortsList(ports: MonitoredPortStatus[]): string {
  let output = '';
  for (const p of ports) {
    const statusIcon = p.status === 'up' ? '🟢' : p.status === 'down' ? '🔴' : '🟡';
    const levelBadge = p.level === 'block' ? '🚫' : p.level === 'error' ? '⚠️' : 'ℹ️';
    const ackBadge = p.acknowledged ? ' ✓' : '';
    output += `### ${statusIcon} Port ${p.port} ${levelBadge}${ackBadge}\n`;
    if (p.description) {
      output += `- **Description:** ${p.description}\n`;
    }
    output += `- **Level:** ${p.level}${p.interval ? ` | **Interval:** ${p.interval}ms` : ''}\n`;
    output += `- **Status:** ${p.status}${p.failedAt ? ` (since ${p.failedAt.toISOString()})` : ''}\n`;
    if (p.acknowledged) {
      output += `- **Acknowledged:** yes\n`;
    }
    output += '\n';
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
      'Manage development servers. Actions: start (start a server from npm script), stop (stop a running server), restart (restart a server), list (list running servers with status), logs (get server console output), stopAll (stop all servers), setAutoRun (enable/disable auto-start on MCP startup)',
      serverSchema,
      async (args: ServerArgs) => {
        switch (args.action) {
          case 'start': {
            if (!args.command) {
              return createErrorResponse('SERVER_MISSING_COMMAND', withLogStatus({}));
            }
            if (!args.cwd) {
              return createErrorResponse('SERVER_MISSING_CWD', withLogStatus({}));
            }
            if (!args.id) {
              return createErrorResponse('SERVER_MISSING_ID', withLogStatus({}));
            }

            try {
              const result = await serverManager.startServer({
                command: args.command,
                cwd: args.cwd,
                id: args.id,
                autoRun: args.autoRun,
                env: args.env,
                runner: args.runner as RunnerType | undefined,
                monitorPort: args.monitorPort,
              });

              // Wait briefly for port detection
              await new Promise(resolve => setTimeout(resolve, 1500));

              const status = await serverManager.getStatus(result.id);
              const serverStatus = status[0];

              return createSuccessResponse('SERVER_START_SUCCESS', withLogStatus({
                id: result.id,
                pid: result.pid,
                runnerType: result.runnerType,
                containerId: result.containerId,
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

              const status = await serverManager.getStatus(result.id);
              const serverStatus = status[0];

              return createSuccessResponse('SERVER_RESTART_SUCCESS', withLogStatus({
                id: result.id,
                pid: result.pid,
                runnerType: result.runnerType,
                containerId: result.containerId,
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
            const servers = await serverManager.getStatus();

            if (servers.length === 0) {
              return createSuccessResponse('SERVER_LIST_EMPTY', withLogStatus({}));
            }

            const runningCount = servers.filter(s => s.running).length;
            const stoppedCount = servers.length - runningCount;
            const dockerCount = servers.filter(s => s.runnerType !== 'native').length;

            return createSuccessResponse('SERVER_LIST_SUCCESS', withLogStatus({
              count: servers.length,
              runningCount,
              stoppedCount,
              dockerCount,
              serverList: formatServerList(servers),
            }));
          }

          case 'logs': {
            if (!args.serverId) {
              return createErrorResponse('SERVER_MISSING_SERVER_ID', withLogStatus({}));
            }

            try {
              const isDelta = args.lines === undefined;
              const logs = await serverManager.getLogs(args.serverId, {
                type: args.logType || 'all',
                lines: args.lines,
                delta: isDelta,
              });

              const status = await serverManager.getStatus(args.serverId);
              const serverStatus = status[0];

              if (logs.length === 0) {
                return createSuccessResponse('SERVER_LOGS_EMPTY', withLogStatus({
                  serverId: args.serverId,
                  running: serverStatus?.running,
                  autoRun: serverStatus?.autoRun,
                  runnerType: serverStatus?.runnerType,
                  isDelta,
                }));
              }

              return createSuccessResponse('SERVER_LOGS_SUCCESS', withLogStatus({
                serverId: args.serverId,
                lineCount: logs.length,
                isDelta,
                running: serverStatus?.running,
                autoRun: serverStatus?.autoRun,
                runnerType: serverStatus?.runnerType,
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

          case 'remove': {
            if (!args.serverId) {
              return createErrorResponse('SERVER_MISSING_SERVER_ID', withLogStatus({}));
            }

            try {
              await serverManager.removeServer(args.serverId);
              return createSuccessResponse('SERVER_REMOVED', withLogStatus({
                serverId: args.serverId,
              }));
            } catch (err) {
              return createErrorResponse('SERVER_NOT_FOUND', withLogStatus({
                serverId: args.serverId,
              }));
            }
          }

          case 'monitorPort': {
            if (args.port === undefined) {
              return createErrorResponse('PORT_MISSING_PORT', withLogStatus({}));
            }
            if (!args.monitoringLevel) {
              return createErrorResponse('PORT_MISSING_LEVEL', withLogStatus({}));
            }

            const portMonitor = serverManager.getPortMonitor();
            await portMonitor.startMonitoring(args.port, args.monitoringLevel, args.description, args.interval);
            await serverManager.saveState();

            return createSuccessResponse('PORT_MONITOR_STARTED', withLogStatus({
              port: args.port,
              level: args.monitoringLevel,
              description: args.description,
              interval: args.interval,
            }));
          }

          case 'unmonitorPort': {
            if (args.port === undefined) {
              return createErrorResponse('PORT_MISSING_PORT', withLogStatus({}));
            }

            const portMonitor = serverManager.getPortMonitor();
            const stopped = await portMonitor.stopMonitoring(args.port);

            if (!stopped) {
              return createErrorResponse('PORT_NOT_MONITORED', withLogStatus({
                port: args.port,
              }));
            }

            await serverManager.saveState();

            return createSuccessResponse('PORT_MONITOR_STOPPED', withLogStatus({
              port: args.port,
            }));
          }

          case 'listMonitored': {
            const portMonitor = serverManager.getPortMonitor();
            const ports = portMonitor.getStatus();

            if (ports.length === 0) {
              return createSuccessResponse('PORT_MONITOR_LIST_EMPTY', withLogStatus({}));
            }

            const upCount = ports.filter(p => p.status === 'up').length;
            const downCount = ports.filter(p => p.status === 'down').length;
            const connectingCount = ports.filter(p => p.status === 'connecting').length;

            return createSuccessResponse('PORT_MONITOR_LIST', withLogStatus({
              count: ports.length,
              upCount,
              downCount,
              connectingCount,
              portList: formatMonitoredPortsList(ports),
            }));
          }

          case 'acknowledgePort': {
            if (args.port === undefined) {
              return createErrorResponse('PORT_MISSING_PORT', withLogStatus({}));
            }

            const portMonitor = serverManager.getPortMonitor();
            const acknowledged = await portMonitor.acknowledgeFailure(args.port);

            if (!acknowledged) {
              return createErrorResponse('PORT_ACK_FAILED', withLogStatus({
                port: args.port,
              }));
            }

            return createSuccessResponse('PORT_ACKNOWLEDGED', withLogStatus({
              port: args.port,
            }));
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
