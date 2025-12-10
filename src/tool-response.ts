/**
 * Tool Response Helpers
 * Functions for modifying tool responses with pre/post content
 */

import type { PortFailureInfo, PendingStartupFailureInfo } from './server-manager.js';
import type { Connection } from './connection-manager.js';
import { hasBlockingBugs, formatBlockingBugs } from './bug-blocker.js';
import { createErrorResponse } from './messages.js';

/**
 * Tool response content item
 */
export interface ContentItem {
  type: string;
  text?: string;
  [key: string]: unknown;
}

// =============================================================================
// Structured Metadata Types (for programmatic use, separate from text output)
// =============================================================================

/**
 * Click action metadata
 */
export interface ClickActionMeta {
  selector: string;
  preClickUrl: string;
  postClickUrl: string;
  navigationOccurred: boolean;
  hasClickHandler: boolean;
  domChanges: {
    mutationCount: number;
    added: number;
    removed: number;
    shown: number;
    hidden: number;
  } | null;
}

/**
 * Type action metadata
 */
export interface TypeActionMeta {
  selector: string;
  text: string;
  actualValue: string;
}

/**
 * Navigate action metadata
 */
export interface NavigateActionMeta {
  url: string;
  title: string;
  action: string;
}

/**
 * Console tool metadata
 */
export interface ConsoleToolMeta {
  totalCount: number;
  matchCount?: number;
  errorCount?: number;
  warnCount?: number;
  /** Number of messages that were truncated */
  truncatedCount?: number;
  /** Total estimated tokens for all full messages */
  totalTokens?: number;
}

/**
 * Network tool metadata
 */
export interface NetworkToolMeta {
  totalCount: number;
  matchCount?: number;
}

/**
 * Root metadata structure for tool responses
 * This provides structured data for programmatic use (validation, replay)
 * while keeping text content free to evolve for human/LLM display
 */
export interface ToolResponseMeta {
  tool: string;
  action?: string;
  timestamp: number;
  // Action-specific structured data
  click?: ClickActionMeta;
  type?: TypeActionMeta;
  navigate?: NavigateActionMeta;
  console?: ConsoleToolMeta;
  network?: NetworkToolMeta;
}

/**
 * Tool response structure
 */
export interface ToolResponse {
  content: ContentItem[];
  isError?: boolean;
  /** Structured metadata for programmatic use (validation, replay). Decoupled from text output. */
  _meta?: ToolResponseMeta;
}

/**
 * Blocking response - prevents tool execution
 */
export interface BlockingResponse {
  blocked: true;
  response: ToolResponse;
}

/**
 * Non-blocking response - allows tool execution with optional modifications
 */
export interface NonBlockingResponse {
  blocked: false;
  prefix: string;
  markAsError: boolean;
}

export type PreExecutionResult = BlockingResponse | NonBlockingResponse;

/**
 * Check for port failures and determine pre-execution behavior
 */
export function checkPortFailures(
  failedPorts: PortFailureInfo[],
  toolName: string
): PreExecutionResult {
  // Check for blocking failures (block level ports that haven't been acknowledged)
  const blockingPorts = failedPorts.filter(p => p.level === 'block');

  if (blockingPorts.length > 0 && toolName !== 'server') {
    // Block all tools except the server tool (needed to acknowledge/manage ports)
    const portList = blockingPorts.map(p =>
      `Port ${p.port}${p.description ? ` (${p.description})` : ''} - down since ${p.failedAt.toISOString()}`
    ).join('\n');

    return {
      blocked: true,
      response: {
        content: [
          {
            type: 'text',
            text: `**BLOCKED: Monitored port(s) failed**\n\nThe following monitored port(s) have failed and require acknowledgment before tools can be used:\n\n${portList}\n\nUse \`server({ action: 'acknowledgePort', port: <port> })\` to acknowledge each failure and continue.`,
          },
        ],
        isError: true
      }
    };
  }

  // Build prefix for error/inform level failures
  let prefix = '';
  const errorPorts = failedPorts.filter(p => p.level === 'error');
  const informPorts = failedPorts.filter(p => p.level === 'inform');

  if (errorPorts.length > 0) {
    const portList = errorPorts.map(p =>
      `Port ${p.port}${p.description ? ` (${p.description})` : ''}`
    ).join(', ');
    prefix += `**ERROR: Monitored port(s) failed:** ${portList}\n\n`;
  }

  if (informPorts.length > 0) {
    const portList = informPorts.map(p =>
      `Port ${p.port}${p.description ? ` (${p.description})` : ''}`
    ).join(', ');
    prefix += `**INFO: Monitored port(s) down:** ${portList}\n\n`;
  }

  return {
    blocked: false,
    prefix,
    markAsError: errorPorts.length > 0
  };
}

/**
 * Tools that are allowed to execute when blocked due to bugs
 * These are tools needed to acknowledge bugs or manage the todo list
 */
const BUG_ALLOWED_TOOLS = new Set([
  'replay',  // Needed to acknowledge bugs
]);

/**
 * Check for blocking bugs from recordings
 */
export function checkBugBlocking(toolName: string): PreExecutionResult {
  if (!hasBlockingBugs()) {
    return { blocked: false, prefix: '', markAsError: false };
  }

  // Allow replay tool to acknowledge bugs
  if (BUG_ALLOWED_TOOLS.has(toolName)) {
    return { blocked: false, prefix: '', markAsError: false };
  }

  const bugList = formatBlockingBugs();

  return {
    blocked: true,
    response: createErrorResponse('BUGS_BLOCKING', { bugList })
  };
}

/**
 * Information about a paused breakpoint
 */
export interface BreakpointPauseInfo {
  reference: string;
  location?: {
    url: string;
    lineNumber: number;
  };
}

/**
 * Tools that are allowed to execute when blocked due to breakpoint pause
 * These are tools needed to inspect the paused state or resume execution
 */
const BREAKPOINT_ALLOWED_TOOLS = new Set([
  'execution',    // Resume, step, pause operations
  'inspect',      // Get call stack, variables, evaluate expression
  'breakpoint',   // Manage breakpoints
  'console',      // View console logs
]);

/**
 * Check for breakpoint pauses and determine pre-execution behavior
 * Similar to checkPortFailures, but for breakpoint blocking
 */
export function checkBreakpointPause(
  connections: Connection[],
  toolName: string
): PreExecutionResult {
  // Find connections that are paused and not acknowledged
  const pausedConnections: BreakpointPauseInfo[] = [];

  for (const conn of connections) {
    if (conn.cdpManager.isPaused() && !conn.breakpointPauseAcknowledged) {
      const pauseInfo = conn.cdpManager.getPausedInfo();
      pausedConnections.push({
        reference: conn.reference || conn.id,
        location: pauseInfo.location,
      });
    }
  }

  // No paused connections, allow execution
  if (pausedConnections.length === 0) {
    return {
      blocked: false,
      prefix: '',
      markAsError: false
    };
  }

  // Check if tool is allowed when paused
  if (BREAKPOINT_ALLOWED_TOOLS.has(toolName)) {
    // Allow but prepend info about paused state
    const pauseList = pausedConnections.map(p => {
      const loc = p.location
        ? ` at ${p.location.url}:${p.location.lineNumber}`
        : '';
      return `"${p.reference}"${loc}`;
    }).join(', ');

    return {
      blocked: false,
      prefix: `**Paused at breakpoint:** ${pauseList}\n\n`,
      markAsError: false
    };
  }

  // Block other tools
  const pauseDetails = pausedConnections.map(p => {
    const loc = p.location
      ? `\n  Location: ${p.location.url}:${p.location.lineNumber}`
      : '';
    return `- "${p.reference}"${loc}`;
  }).join('\n');

  return {
    blocked: true,
    response: {
      content: [
        {
          type: 'text',
          text: `**BLOCKED: Execution paused at breakpoint**

The following connection(s) are paused at a breakpoint:
${pauseDetails}

**To continue:**
- Use \`execution({ action: 'resume' })\` to resume execution
- Use \`execution({ action: 'acknowledge' })\` to acknowledge and continue using other tools while paused
- Use \`inspect({ action: 'getCallStack' })\` or \`inspect({ action: 'getVariables' })\` to examine state

Other tools are blocked until execution is resumed or acknowledged.`,
        },
      ],
      isError: true
    }
  };
}

/**
 * Check for pending startup failures and determine pre-execution behavior
 * Blocks tools when servers have failed to start (timeout or died) and not acknowledged
 */
export function checkPendingStartups(
  failures: PendingStartupFailureInfo[],
  toolName: string
): PreExecutionResult {
  // No failures, allow execution
  if (failures.length === 0) {
    return {
      blocked: false,
      prefix: '',
      markAsError: false
    };
  }

  // Server tool is always allowed (needed to acknowledge/manage servers)
  if (toolName === 'server') {
    return {
      blocked: false,
      prefix: '',
      markAsError: false
    };
  }

  // Build blocking message based on failure reasons
  const timeoutFailures = failures.filter(f => f.reason === 'timeout');
  const diedFailures = failures.filter(f => f.reason === 'died');

  let message = '**BLOCKED: Server startup issue(s)**\n\n';

  if (timeoutFailures.length > 0) {
    message += `**Startup timeout** - The following server(s) started but no port was detected within 30 seconds:\n`;
    for (const f of timeoutFailures) {
      const elapsed = Math.round((Date.now() - f.startedAt.getTime()) / 1000);
      message += `- "${f.serverId}" (started ${elapsed}s ago)\n`;
    }
    message += '\n';
  }

  if (diedFailures.length > 0) {
    message += `**Server died** - The following server(s) died before port was detected:\n`;
    for (const f of diedFailures) {
      message += `- "${f.serverId}"\n`;
    }
    message += '\n';
  }

  message += `**Options:**\n`;
  message += `- Check logs: \`server({ action: 'logs', serverId: '<id>' })\`\n`;
  message += `- Acknowledge and continue: \`server({ action: 'acknowledgeStartup', serverId: '<id>' })\`\n`;

  if (timeoutFailures.length > 0) {
    message += `- Extend timeout 30s: \`server({ action: 'extendStartup', serverId: '<id>' })\`\n`;
  }

  if (diedFailures.length > 0) {
    message += `- Restart server: \`server({ action: 'restart', serverId: '<id>' })\`\n`;
  }

  message += `- Stop server: \`server({ action: 'stop', serverId: '<id>' })\``;

  return {
    blocked: true,
    response: {
      content: [
        {
          type: 'text',
          text: message,
        },
      ],
      isError: true
    }
  };
}

/**
 * Prepend text to the first text content item in a response
 */
export function prependToResponse(response: ToolResponse, prefix: string): void {
  if (!prefix || !response.content || response.content.length === 0) return;

  const firstContent = response.content[0];
  if (firstContent && firstContent.type === 'text' && firstContent.text) {
    firstContent.text = prefix + firstContent.text;
  }
}

/**
 * Append text to the last text content item in a response
 */
export function appendToResponse(response: ToolResponse, suffix: string): void {
  if (!suffix || !response.content || response.content.length === 0) return;

  const lastContent = response.content[response.content.length - 1];
  if (lastContent && lastContent.type === 'text' && lastContent.text) {
    lastContent.text += suffix;
  }
}

/**
 * Status line item for post-response status
 */
export interface StatusLineItem {
  label: string;
  value: string;
}

/**
 * Build status lines suffix from items
 */
export function buildStatusSuffix(items: StatusLineItem[]): string {
  if (items.length === 0) return '';

  const lines = items.map(item => `**${item.label}:** ${item.value}`);
  return `\n\n---\n${lines.join('\n')}`;
}
