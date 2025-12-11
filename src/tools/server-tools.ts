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
  action: z.enum(['start', 'stop', 'restart', 'list', 'logs', 'stopAll', 'setAutoRun', 'clearLogs', 'remove', 'monitorPort', 'unmonitorPort', 'listMonitored', 'acknowledgePort', 'acknowledgeStartup', 'extendStartup'])
    .describe('Server action: start (start a server), stop (stop a server), restart (restart a server), list (list servers), logs (get server logs), stopAll (stop all servers), setAutoRun (enable/disable auto-start on MCP startup), clearLogs (clear log files for a server), remove (remove server from config), monitorPort (start monitoring a port), unmonitorPort (stop monitoring a port), listMonitored (list monitored ports), acknowledgePort (acknowledge a port failure), acknowledgeStartup (acknowledge startup timeout/failure), extendStartup (extend startup timeout by 30s)'),
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
  global: z.boolean().optional()
    .describe('If true, store/lookup server state in global ~/.cdp-tools/ instead of project directory. Use this when running MCP from a different directory than where the server was started.'),
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
 * Format server list as CSV
 */
function formatServerList(servers: ServerStatus[]): string {
  const escapeCSV = (val: string | number | boolean | undefined): string => {
    if (val === undefined) return '';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const headers = ['status', 'id', 'storage', 'port', 'runner', 'pid', 'uptime', 'autoRun', 'cwd', 'command'];
  const rows = servers.map(s => [
    s.running ? 'running' : 'stopped',
    s.id,
    s.global ? 'global' : 'local',
    s.port ?? '',
    s.runnerType,
    s.runnerType === 'native' ? s.pid : (s.containerId ?? ''),
    s.uptime,
    s.autoRun ? 'yes' : 'no',
    s.cwd,
    s.command,
  ].map(escapeCSV).join(','));

  return [headers.join(','), ...rows].join('\n');
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
      'Manage development servers. Actions: start (start a server from npm script), stop (stop a running server), restart (restart a server), list (list running servers with status), logs (get log file paths or docker command), stopAll (stop all servers), setAutoRun (enable/disable auto-start on MCP startup)',
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
                global: args.global,
              });

              // Wait briefly for port detection
              await new Promise(resolve => setTimeout(resolve, 1500));

              const status = await serverManager.getStatus(result.id);
              const serverStatus = status[0];

              // Check if port was detected
              if (serverStatus?.port) {
                // Port detected - server fully started
                return createSuccessResponse('SERVER_START_SUCCESS', withLogStatus({
                  id: result.id,
                  pid: result.pid,
                  runnerType: result.runnerType,
                  containerId: result.containerId,
                  port: serverStatus.port,
                  autoRun: serverStatus?.autoRun,
                }));
              } else {
                // Port not yet detected - server starting, pending detection
                return createSuccessResponse('SERVER_START_PENDING', withLogStatus({
                  id: result.id,
                  pid: result.pid,
                  runnerType: result.runnerType,
                  containerId: result.containerId,
                  autoRun: serverStatus?.autoRun,
                }));
              }
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
              const status = await serverManager.getStatus(args.serverId);
              const serverStatus = status[0];
              const logAccess = serverManager.getLogAccess(args.serverId);

              if (!logAccess) {
                return createErrorResponse('SERVER_LOGS_UNAVAILABLE', withLogStatus({
                  serverId: args.serverId,
                }));
              }

              if (logAccess.type === 'file') {
                return createSuccessResponse('SERVER_LOGS_FILE', withLogStatus({
                  serverId: args.serverId,
                  running: serverStatus?.running,
                  autoRun: serverStatus?.autoRun,
                  runnerType: serverStatus?.runnerType,
                  port: serverStatus?.port,
                  uptime: serverStatus?.uptime,
                  logDir: logAccess.logDir,
                  stdoutPath: logAccess.stdoutPath,
                  stderrPath: logAccess.stderrPath,
                }));
              } else {
                return createSuccessResponse('SERVER_LOGS_COMMAND', withLogStatus({
                  serverId: args.serverId,
                  running: serverStatus?.running,
                  autoRun: serverStatus?.autoRun,
                  runnerType: serverStatus?.runnerType,
                  port: serverStatus?.port,
                  uptime: serverStatus?.uptime,
                  command: logAccess.command,
                }));
              }
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

          case 'acknowledgeStartup': {
            if (!args.serverId) {
              return createErrorResponse('SERVER_MISSING_SERVER_ID', withLogStatus({}));
            }

            // Get the pending startup info before acknowledging (to know the reason)
            const pendingInfo = serverManager.getPendingStartup(args.serverId);
            const reason = pendingInfo?.reason;

            const ackResult = await serverManager.acknowledgeStartup(args.serverId);

            if (!ackResult) {
              return createErrorResponse('STARTUP_ACK_FAILED', withLogStatus({
                serverId: args.serverId,
                error: 'Server not found or no pending startup to acknowledge',
              }));
            }

            // Use different message based on reason
            if (reason === 'died') {
              return createSuccessResponse('STARTUP_ACKNOWLEDGED_DIED', withLogStatus({
                serverId: args.serverId,
              }));
            }

            return createSuccessResponse('STARTUP_ACKNOWLEDGED', withLogStatus({
              serverId: args.serverId,
            }));
          }

          case 'extendStartup': {
            if (!args.serverId) {
              return createErrorResponse('SERVER_MISSING_SERVER_ID', withLogStatus({}));
            }

            const extendResult = await serverManager.extendStartupTimeout(args.serverId);

            if (!extendResult) {
              return createErrorResponse('STARTUP_EXTEND_FAILED', withLogStatus({
                serverId: args.serverId,
                error: 'Server not found, server died, or no pending startup to extend',
              }));
            }

            return createSuccessResponse('STARTUP_EXTENDED', withLogStatus({
              serverId: args.serverId,
              timeout: '30s',
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
