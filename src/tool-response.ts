/**
 * Tool Response Helpers
 * Functions for modifying tool responses with pre/post content
 */

import type { PortFailureInfo } from './server-manager.js';

/**
 * Tool response content item
 */
export interface ContentItem {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/**
 * Tool response structure
 */
export interface ToolResponse {
  content: ContentItem[];
  isError?: boolean;
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
