/**
 * Console Message Formatting
 *
 * Formats console messages for different output modes:
 * - Preview: Compact CSV for list/recent/search (minimal tokens)
 * - Summary: Smart truncation for detail view (budget-constrained)
 * - Full: Complete message with all data
 */

// =============================================================================
// Constants
// =============================================================================

/** Token budget for smart summary mode */
export const DEFAULT_SUMMARY_TOKEN_BUDGET = 100;

/** Max characters for preview text in list mode */
const DEFAULT_PREVIEW_MAX_CHARS = 200;

/** Budget allocation for summary mode */
const SUMMARY_BUDGET = {
  text: 0.6,    // 60% for message text
  args: 0.25,   // 25% for arguments
  stack: 0.15,  // 15% for stack trace
};

// =============================================================================
// Token Estimation
// =============================================================================

/**
 * Estimate token count for a value (~4 chars per token)
 */
export function estimateTokens(value: any): number {
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  return Math.ceil(str.length / 4);
}

// =============================================================================
// Types
// =============================================================================

/** Compact preview for list/recent/search (CSV output) */
export interface ConsoleMessagePreview {
  id: string;
  type: string;
  preview: string;
  tokens: number;
  truncated: boolean;
}

/** Smart summary for detail view with token budget */
export interface ConsoleMessageSummary {
  id: string;
  type: string;
  text: string;
  textTruncated?: { shown: number; total: number };
  args?: any[];
  argsSummary?: string;
  location?: { url: string; lineNumber: number; columnNumber: number };
  stackTrace?: { shown: number; total: number; frames: any[] };
  timestamp: number;
  _tokens: { full: number; returned: number };
}

/** Input for preview/summary creation (matches StoredConsoleMessage) */
interface MessageInput {
  id: string;
  type: string;
  text: string;
  args?: any[];
  location?: { url: string; lineNumber: number; columnNumber: number };
  stackTrace?: any[];
  timestamp: number;
}

// =============================================================================
// Preview Mode (for list/recent/search)
// =============================================================================

/**
 * Create a compact preview of a console message for list views.
 * Returns minimal data with token count for the full message.
 */
export function createMessagePreview(message: MessageInput): ConsoleMessagePreview {
  const fullTokens = estimateTokens({ text: message.text, args: message.args });

  let preview = message.text;
  let truncated = false;

  if (preview.length > DEFAULT_PREVIEW_MAX_CHARS) {
    preview = preview.substring(0, DEFAULT_PREVIEW_MAX_CHARS) + '...';
    truncated = true;
  }

  // Mark as truncated if args contain significant content
  if (message.args && message.args.length > 0 && estimateTokens(message.args) > 10) {
    truncated = true;
  }

  return { id: message.id, type: message.type, preview, tokens: fullTokens, truncated };
}

/**
 * Format message previews as CSV and calculate stats
 */
export function formatPreviewsWithStats(previews: ConsoleMessagePreview[]): {
  csv: string;
  truncatedCount: number;
  totalTokens: number;
} {
  const header = 'id,type,tokens,truncated,preview';
  const rows = previews.map(p =>
    `${p.id},${p.type},${p.tokens},${p.truncated},${escapeCsvValue(p.preview)}`
  );

  return {
    csv: [header, ...rows].join('\n'),
    truncatedCount: previews.filter(p => p.truncated).length,
    totalTokens: previews.reduce((sum, p) => sum + p.tokens, 0),
  };
}

/**
 * Build complete list response text
 */
export function buildListResponseText(
  headerText: string,
  csv: string,
  truncatedCount: number,
  totalTokens: number
): string {
  return `${headerText}\nTruncated: ${truncatedCount}, Total tokens if expanded: ~${totalTokens}\n\n\`\`\`csv\n${csv}\n\`\`\`\n\nUse \`console({ action: 'get', id: '...' })\` to expand a message.`;
}

// =============================================================================
// Summary Mode (for detail view with budget)
// =============================================================================

/**
 * Create a smart summary of a console message within a token budget.
 * Prioritizes: text > args > stack trace
 */
export function createMessageSummary(
  message: MessageInput,
  tokenBudget: number = DEFAULT_SUMMARY_TOKEN_BUDGET
): ConsoleMessageSummary {
  const fullTokens = estimateTokens({
    text: message.text,
    args: message.args,
    stackTrace: message.stackTrace,
  });

  // If under budget, return as-is
  if (fullTokens <= tokenBudget) {
    return {
      id: message.id,
      type: message.type,
      text: message.text,
      args: message.args,
      location: message.location,
      stackTrace: message.stackTrace
        ? { shown: message.stackTrace.length, total: message.stackTrace.length, frames: message.stackTrace }
        : undefined,
      timestamp: message.timestamp,
      _tokens: { full: fullTokens, returned: fullTokens },
    };
  }

  // Allocate budget
  const textBudget = Math.floor(tokenBudget * SUMMARY_BUDGET.text);
  const argsBudget = Math.floor(tokenBudget * SUMMARY_BUDGET.args);
  const stackBudget = Math.floor(tokenBudget * SUMMARY_BUDGET.stack);

  const result: ConsoleMessageSummary = {
    id: message.id,
    type: message.type,
    text: message.text,
    location: message.location,
    timestamp: message.timestamp,
    _tokens: { full: fullTokens, returned: 0 },
  };

  // Truncate text if needed
  if (estimateTokens(message.text) > textBudget) {
    const maxChars = textBudget * 4;
    result.text = message.text.substring(0, maxChars) + '...';
    result.textTruncated = { shown: maxChars, total: message.text.length };
  }

  // Summarize or include args
  if (message.args && message.args.length > 0) {
    if (estimateTokens(message.args) > argsBudget) {
      result.argsSummary = summarizeArgs(message.args);
    } else {
      result.args = message.args;
    }
  }

  // Limit stack trace
  if (message.stackTrace && message.stackTrace.length > 0) {
    const maxFrames = Math.max(2, Math.floor(stackBudget / 10));
    result.stackTrace = {
      shown: Math.min(maxFrames, message.stackTrace.length),
      total: message.stackTrace.length,
      frames: message.stackTrace.slice(0, maxFrames),
    };
  }

  result._tokens.returned = estimateTokens(result);
  return result;
}

/**
 * Generate hints for how to extract more data from a truncated summary
 */
export function generateSummaryHints(summary: ConsoleMessageSummary): string {
  const hints: string[] = [];

  if (summary.textTruncated) {
    hints.push(`Text truncated: ${summary.textTruncated.shown}/${summary.textTruncated.total} chars. Use \`textOffset\`/\`textLimit\` to extract more.`);
  }
  if (summary.argsSummary) {
    hints.push(`Args summarized. Use \`argsIndex: N\` to get specific arg.`);
  }
  if (summary.stackTrace && summary.stackTrace.shown < summary.stackTrace.total) {
    hints.push(`Stack trace: ${summary.stackTrace.shown}/${summary.stackTrace.total} frames shown. Use \`full: true\` for all.`);
  }

  return hints.length > 0 ? '\n' + hints.join('\n') : '';
}

/**
 * Build summary response text
 */
export function buildSummaryResponseText(
  message: { id: string; type: string },
  summary: ConsoleMessageSummary,
  jsonBlock: string
): string {
  const hints = generateSummaryHints(summary);
  return `Console message [${message.id}] - Type: ${message.type}\nTokens: ${summary._tokens.returned} returned / ${summary._tokens.full} full${hints}\n\n${jsonBlock}`;
}

// =============================================================================
// Extraction Helpers
// =============================================================================

/** Result of text extraction */
export interface TextExtractionResult {
  text: string;
  extraction?: { offset: number; limit?: number; total: number; hasMore: boolean };
}

/** Result of args extraction */
export type ArgsExtractionResult =
  | { args: any[]; extraction: { index: number; total: number } }
  | { error: string };

/**
 * Extract a portion of text from a message
 */
export function extractTextPortion(text: string, offset?: number, limit?: number): TextExtractionResult {
  if (offset === undefined && limit === undefined) {
    return { text };
  }

  const actualOffset = offset ?? 0;
  const total = text.length;

  if (limit !== undefined) {
    return {
      text: text.substring(actualOffset, actualOffset + limit),
      extraction: { offset: actualOffset, limit, total, hasMore: actualOffset + limit < total },
    };
  }

  if (actualOffset > 0) {
    return {
      text: text.substring(actualOffset),
      extraction: { offset: actualOffset, total, hasMore: false },
    };
  }

  return { text };
}

/**
 * Extract a specific argument by index
 */
export function extractArgByIndex(args: any[] | undefined, index: number): ArgsExtractionResult {
  if (!args || args.length === 0) {
    return { error: 'Message has no args' };
  }

  if (index < 0 || index >= args.length) {
    return { error: `argsIndex ${index} is out of range (0-${args.length - 1})` };
  }

  return { args: [args[index]], extraction: { index, total: args.length } };
}

// =============================================================================
// TOON Formatting (for get action)
// =============================================================================

/**
 * Format a value for TOON output
 * - Wrap in () if contains spaces or special chars
 * - Arrays use [item|item]
 * - Objects use {key:value;...}
 */
function formatToonValue(value: any, maxDepth: number = 2, currentDepth: number = 0): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);

  if (typeof value === 'string') {
    // Escape special chars and wrap if needed
    if (value.includes(';') || value.includes(':') || value.includes('|') ||
        value.includes('{') || value.includes('}') || value.includes('[') ||
        value.includes(']') || value.includes('(') || value.includes(')') ||
        value.includes(' ') || value.includes('\n')) {
      // Replace problematic chars and wrap
      const escaped = value.replace(/[()]/g, '').replace(/\n/g, '\\n').substring(0, 200);
      return `(${escaped}${value.length > 200 ? '...' : ''})`;
    }
    return value.substring(0, 100) + (value.length > 100 ? '...' : '');
  }

  if (currentDepth >= maxDepth) {
    if (Array.isArray(value)) return `[Array:${value.length}]`;
    return `[Object:${Object.keys(value).length}keys]`;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.slice(0, 5).map(v => formatToonValue(v, maxDepth, currentDepth + 1));
    const suffix = value.length > 5 ? `|+${value.length - 5}more` : '';
    return `[${items.join('|')}${suffix}]`;
  }

  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    const pairs = keys.slice(0, 5).map(k => `${k}:${formatToonValue(value[k], maxDepth, currentDepth + 1)}`);
    const suffix = keys.length > 5 ? `;+${keys.length - 5}more` : '';
    return `{${pairs.join(';')}${suffix}}`;
  }

  return String(value);
}

/**
 * Format console message summary as TOON (one property per line for readability)
 */
export function formatSummaryAsToon(summary: ConsoleMessageSummary): string {
  const lines: string[] = [
    `id:${summary.id}`,
    `type:${summary.type}`,
    `text:${formatToonValue(summary.text)}`,
  ];

  if (summary.textTruncated) {
    lines.push(`textTruncated:{shown:${summary.textTruncated.shown};total:${summary.textTruncated.total}}`);
  }

  if (summary.argsSummary) {
    lines.push(`argsSummary:(${summary.argsSummary})`);
  } else if (summary.args && summary.args.length > 0) {
    lines.push(`args:${formatToonValue(summary.args)}`);
  }

  if (summary.location) {
    const loc = summary.location;
    lines.push(`location:{url:${formatToonValue(loc.url)};line:${loc.lineNumber};col:${loc.columnNumber}}`);
  }

  if (summary.stackTrace) {
    const st = summary.stackTrace;
    const frames = st.frames.map(f => `{url:${formatToonValue(f.url)};line:${f.lineNumber}}`).join('|');
    lines.push(`stack:{shown:${st.shown};total:${st.total};frames:[${frames}]}`);
  }

  lines.push(`tokens:{full:${summary._tokens.full};returned:${summary._tokens.returned}}`);

  return lines.join('\n');
}

/**
 * Format full message detail as TOON (one property per line for readability)
 */
export function formatMessageDetailAsToon(data: {
  id: string;
  type: string;
  text: string;
  args?: any[];
  location?: { url: string; lineNumber: number; columnNumber: number };
  stackTrace?: any[];
  timestamp: number;
  _tokens: { full: number; returned: number };
  _textExtraction?: { offset: number; limit?: number; total: number; hasMore: boolean };
  _argsExtraction?: { index: number; total: number };
}): string {
  const lines: string[] = [
    `id:${data.id}`,
    `type:${data.type}`,
    `text:${formatToonValue(data.text)}`,
  ];

  if (data.args && data.args.length > 0) {
    lines.push(`args:${formatToonValue(data.args)}`);
  }

  if (data.location) {
    lines.push(`location:{url:${formatToonValue(data.location.url)};line:${data.location.lineNumber}}`);
  }

  if (data.stackTrace && data.stackTrace.length > 0) {
    const frames = data.stackTrace.slice(0, 3).map(f =>
      `{url:${formatToonValue(f.url)};line:${f.lineNumber}}`
    ).join('|');
    const suffix = data.stackTrace.length > 3 ? `|+${data.stackTrace.length - 3}more` : '';
    lines.push(`stack:[${frames}${suffix}]`);
  }

  lines.push(`tokens:{full:${data._tokens.full};returned:${data._tokens.returned}}`);

  if (data._textExtraction) {
    const te = data._textExtraction;
    lines.push(`textExtract:{offset:${te.offset};total:${te.total};hasMore:${te.hasMore}}`);
  }

  if (data._argsExtraction) {
    lines.push(`argsExtract:{index:${data._argsExtraction.index};total:${data._argsExtraction.total}}`);
  }

  return lines.join('\n');
}

// =============================================================================
// Helpers
// =============================================================================

function escapeCsvValue(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

function summarizeArgs(args: any[]): string {
  return args.map((arg, i) => {
    if (arg === null) return `[${i}]: null`;
    if (arg === undefined) return `[${i}]: undefined`;
    if (typeof arg === 'string') return `[${i}]: string(${arg.length} chars)`;
    if (typeof arg === 'number') return `[${i}]: ${arg}`;
    if (typeof arg === 'boolean') return `[${i}]: ${arg}`;
    if (Array.isArray(arg)) return `[${i}]: Array(${arg.length})`;
    if (typeof arg === 'object') {
      const keys = Object.keys(arg);
      return `[${i}]: Object{${keys.slice(0, 3).join(', ')}${keys.length > 3 ? '...' : ''}}`;
    }
    return `[${i}]: ${typeof arg}`;
  }).join(', ');
}
