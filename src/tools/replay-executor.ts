/**
 * Replay Executor - Core execution engine for command sequences
 */

import type { CommandRecorder, RecordedCommand, CommandSequence, ActiveSequenceState } from '../command-recorder.js';
import { debugLog } from '../debug-logger.js';
import { sanitizeReference, requireValidReference } from '../reference-validator.js';
import { checkUrlPort } from '../utils/port-check.js';
import { configManager, ClickValidationConfig } from '../config.js';
import type { ClickActionMeta, ConsoleToolMeta, NetworkToolMeta } from '../tool-response.js';
import { interpolateParams } from './interpolation.js';

// Re-export replay cursor functions
export { injectReplayCursor, showClickEffect, showKeyPress, removeReplayCursor } from '../replay-cursor.js';

// =============================================================================
// Replay Cursor Callbacks
// =============================================================================

interface ReplayCursorCallbacks {
  onClickBefore?: (x: number, y: number, isRightClick: boolean) => Promise<void>;
  onKeyPress?: (key: string) => Promise<void>;
}

let replayCursorCallbacks: ReplayCursorCallbacks = {};

export function setReplayCursorCallbacks(callbacks: ReplayCursorCallbacks): void {
  replayCursorCallbacks = callbacks;
}

// =============================================================================
// Types
// =============================================================================

export interface ExecutionContext {
  executeToolCall: (toolName: string, params: Record<string, any>) => Promise<any>;
  commandRecorder: CommandRecorder;
  connectionReason: string;
  logPrefix?: string;
  /** Current nesting depth for conditional commands (used for recursion protection) */
  conditionalDepth?: number;
  /** Call stack of sequence names for circular reference detection */
  conditionalCallStack?: string[];
  /** Per-run variable store for {{var:name.path}} interpolation. Populated by
   *  request({ saveAs }) steps, consumed by later steps' param interpolation. */
  variableStore?: Record<string, any>;
  /** {{timestamp}} value for this run, computed once and cached (not per-step). */
  runTimestamp?: number;
}

export interface StepResult {
  step: number;
  tool: string;
  success: boolean;
  error?: string;
  // For conditional commands - nested substeps
  substeps?: StepResult[];
  sequenceName?: string;
  conditionMet?: boolean;
}

export interface BreakpointHitInfo {
  url: string;
  lineNumber: number;
  columnNumber?: number;
  functionName?: string;
}

export interface ClickValidationFailure {
  step: number;
  selector: string;
  errors: string[];
  warnings: string[];
  info: string[];
}

export interface ExecutionResult {
  results: StepResult[];
  totalCommands: number;
  durationMs: number;
  pausedAtStep?: number;
  activeSequenceState?: ActiveSequenceState;
  breakpointHit?: BreakpointHitInfo;
  /** Click validation failure - sequence paused for inspection/retry */
  clickValidationFailure?: ClickValidationFailure;
}

export interface ConnectionAnalysis {
  launchChromeIndex: number;
  firstConnectionToolIndex: number;
  hasLaunchBeforeConnection: boolean;
}

// =============================================================================
// Constants
// =============================================================================

export const TOOLS_NEEDING_CONNECTION = [
  'navigate', 'content', 'input', 'console', 'network', 'dom', 'screenshot', 'storage'
];

// =============================================================================
// Conditional Evaluation
// =============================================================================

/**
 * Result of condition evaluation
 * - met: true - condition matched
 * - met: false, isError: undefined - condition legitimately not met
 * - met: false, isError: true - evaluation FAILED (should stop sequence)
 */
export type ConditionResult =
  | { met: true }
  | { met: false; reason?: string }
  | { met: false; reason: string; isError: true };

/**
 * Evaluate a handlebar-style condition
 * Supported patterns:
 *   {{selector:CSS_SELECTOR}}     - true if element exists
 *   {{!selector:CSS_SELECTOR}}    - true if element does NOT exist
 *   {{url:contains:STRING}}       - true if URL contains string
 *   {{url:matches:REGEX}}         - true if URL matches regex
 *   {{cookie:NAME}}               - true if cookie exists
 *   {{!cookie:NAME}}              - true if cookie does NOT exist
 *   {{localStorage:KEY}}          - true if localStorage key exists
 *   {{!localStorage:KEY}}         - true if localStorage key does NOT exist
 */
export async function evaluateCondition(
  condition: string,
  ctx: ExecutionContext
): Promise<ConditionResult> {
  const { executeToolCall, connectionReason, logPrefix = 'executor' } = ctx;
  const replayConfig = configManager.getReplayConfig();

  // Parse the handlebar pattern
  const match = condition.match(/^\{\{(!?)(\w+):(.+)\}\}$/);
  if (!match) {
    return {
      met: false,
      reason: `Invalid condition format: "${condition}". Expected {{type:value}} or {{!type:value}}. Supported types: selector, url, cookie, localStorage`,
      isError: true
    };
  }

  const [, negated, type, value] = match;
  const isNegated = negated === '!';

  await debugLog(logPrefix, `Evaluating condition: ${type}${isNegated ? ' (negated)' : ''} = ${value}`);

  try {
    let conditionMet = false;

    switch (type) {
      case 'selector': {
        const result = await executeToolCall('dom', {
          action: 'querySelector',
          selector: value,
          connectionReason
        });
        const resultText = result?.content?.[0]?.text || '';
        conditionMet = !result?.isError && resultText.includes('Element found');
        break;
      }

      case 'url': {
        const pageInfo = await executeToolCall('navigate', {
          action: 'info',
          connectionReason
        });
        const pageText = pageInfo?.content?.[0]?.text || '';
        const urlMatch = pageText.match(/URL:\s*([^\s,]+)/);
        const currentUrl = urlMatch ? urlMatch[1] : '';

        if (value.startsWith('contains:')) {
          const searchStr = value.substring('contains:'.length);
          conditionMet = currentUrl.includes(searchStr);
        } else if (value.startsWith('matches:')) {
          const pattern = value.substring('matches:'.length);

          // Check regex length limit
          if (pattern.length > replayConfig.maxRegexLength) {
            return {
              met: false,
              reason: `Regex pattern too long (${pattern.length} chars, max ${replayConfig.maxRegexLength}). Simplify the pattern or increase maxRegexLength in config.`,
              isError: true
            };
          }

          // Safely compile regex
          let regex: RegExp;
          try {
            regex = new RegExp(pattern);
          } catch (regexError: any) {
            return {
              met: false,
              reason: `Invalid regex pattern "${pattern}": ${regexError.message}. Check syntax at https://regex101.com (JavaScript flavor).`,
              isError: true
            };
          }

          conditionMet = regex.test(currentUrl);
        } else {
          conditionMet = currentUrl === value;
        }
        break;
      }

      case 'cookie': {
        const result = await executeToolCall('storage', {
          action: 'getCookies',
          connectionReason
        });
        const resultText = result?.content?.[0]?.text || '';
        conditionMet = resultText.includes(`"name": "${value}"`) || resultText.includes(`name=${value}`);
        break;
      }

      case 'localStorage': {
        const result = await executeToolCall('storage', {
          action: 'getLocalStorage',
          key: value,
          connectionReason
        });
        const resultText = result?.content?.[0]?.text || '';
        conditionMet = !result?.isError && !resultText.includes('not found') && !resultText.includes('null');
        break;
      }

      default:
        return {
          met: false,
          reason: `Unknown condition type: "${type}". Supported types: selector, url, cookie, localStorage`,
          isError: true
        };
    }

    // Apply negation
    const finalResult = isNegated ? !conditionMet : conditionMet;
    await debugLog(logPrefix, `Condition ${condition} = ${finalResult}`);

    if (finalResult) {
      return { met: true };
    } else {
      return { met: false };
    }
  } catch (error: any) {
    // Tool execution errors are real errors, not just "condition not met"
    return {
      met: false,
      reason: `Error evaluating ${type} condition: ${error.message}`,
      isError: true
    };
  }
}

export interface ConditionalFlowResult {
  success: boolean;
  executed: boolean;
  sequenceName: string;
  substeps?: StepResult[];
  error?: string;
  durationMs?: number;
}

/**
 * Execute a conditional flow - runs a sequence if condition is met
 */
export async function executeConditionalFlow(
  condition: string,
  sequenceName: string,
  ctx: ExecutionContext,
  recorder: CommandRecorder
): Promise<ConditionalFlowResult> {
  const { logPrefix = 'executor' } = ctx;
  const replayConfig = configManager.getReplayConfig();
  const currentDepth = ctx.conditionalDepth ?? 0;
  const callStack = ctx.conditionalCallStack ?? [];

  // Check recursion depth limit - allows oscillating patterns (A→B→A) up to max depth
  if (currentDepth >= replayConfig.maxConditionalDepth) {
    const chain = [...callStack, sequenceName].join(' → ');
    await debugLog(logPrefix, `Conditional depth limit exceeded: ${chain}`);
    return {
      success: false,
      executed: false,
      sequenceName,
      error: `Conditional depth limit (${replayConfig.maxConditionalDepth}) reached: ${chain}. Increase maxConditionalDepth in config if this is intentional.`
    };
  }

  // Evaluate the condition
  const condResult = await evaluateCondition(condition, ctx);

  if (!condResult.met) {
    // Check if this is an error vs genuine "condition not met"
    if ('isError' in condResult && condResult.isError) {
      // This is an ERROR - fail the sequence
      await debugLog(logPrefix, `Condition evaluation ERROR: ${condResult.reason}`);
      return {
        success: false,
        executed: false,
        sequenceName,
        error: `Condition evaluation failed: ${condResult.reason}`
      };
    }

    // Genuine "condition not met" - this is success (we correctly evaluated and skipped)
    if ('reason' in condResult && condResult.reason) {
      await debugLog(logPrefix, `Condition not met: ${condResult.reason}`);
    } else {
      await debugLog(logPrefix, `Condition ${condition} not met, skipping sequence ${sequenceName}`);
    }
    return { success: true, executed: false, sequenceName };
  }

  await debugLog(logPrefix, `Condition ${condition} met, loading sequence: ${sequenceName}`);

  // Load the sequence
  const loadResult = await loadSequence({ name: sequenceName }, recorder);
  if (!loadResult.success) {
    return { success: false, executed: false, sequenceName, error: `Sequence "${sequenceName}" not found: ${loadResult.error}` };
  }

  const sequence = loadResult.sequence;

  // Filter out launchChrome commands - we already have a connection
  const filteredCommands = sequence.commands.filter(cmd => cmd.tool !== 'launchChrome');
  const filteredSequence = { ...sequence, commands: filteredCommands };

  await debugLog(logPrefix, `Executing conditional sequence "${sequence.name}" with ${filteredCommands.length} commands (depth: ${currentDepth + 1})`);

  // Execute the sequence with updated call stack and depth
  const execResult = await executeSteps({
    sequence: filteredSequence,
    startStep: 0,
    ctx: {
      ...ctx,
      conditionalDepth: currentDepth + 1,
      conditionalCallStack: [...callStack, sequenceName]
    },
  });

  // Check for failures
  const failedStep = execResult.results.find(r => !r.success);
  if (failedStep) {
    // Don't wrap errors that are already from nested conditionals - just pass through
    const isNestedConditionalError = failedStep.tool === 'conditional' ||
      failedStep.error?.includes('Conditional depth limit') ||
      failedStep.error?.includes('Condition evaluation failed');

    const error = isNestedConditionalError
      ? failedStep.error
      : `Conditional sequence "${sequenceName}" failed at step ${failedStep.step} (${failedStep.tool}): ${failedStep.error}`;

    return {
      success: false,
      executed: true,
      sequenceName,
      substeps: execResult.results,
      error,
      durationMs: execResult.durationMs
    };
  }

  await debugLog(logPrefix, `Conditional sequence completed successfully in ${execResult.durationMs}ms`);
  return {
    success: true,
    executed: true,
    sequenceName,
    substeps: execResult.results,
    durationMs: execResult.durationMs
  };
}

// =============================================================================
// Sequence Loading
// =============================================================================

export interface LoadSequenceArgs {
  name?: string;
  sequenceId?: string;
}

export type LoadSequenceResult = {
  success: true;
  sequence: CommandSequence;
} | {
  success: false;
  error: string;
  errorCode: string;
  /** Template variables for error response (e.g., action, missing for MISSING_PARAMETER) */
  templateVars?: Record<string, string>;
};

/**
 * Load a sequence from memory (by sequenceId) or disk (by name)
 */
export async function loadSequence(
  args: LoadSequenceArgs,
  recorder: CommandRecorder
): Promise<LoadSequenceResult> {
  if (args.sequenceId) {
    const sequence = recorder.getSequence(args.sequenceId);
    if (!sequence) {
      return {
        success: false,
        error: `Sequence "${args.sequenceId}" not found in memory. Use listSaved to see disk sequences or list for memory sequences.`,
        errorCode: 'SEQUENCE_NOT_FOUND'
      };
    }
    return { success: true, sequence };
  }

  if (args.name) {
    // Check memory first
    const memorySequences = recorder.listSequences();
    const memoryMatch = memorySequences.find(s => s.name === args.name);
    if (memoryMatch) {
      await debugLog('executor', `Found sequence "${memoryMatch.name}" in memory`);
      return { success: true, sequence: memoryMatch };
    }

    // Then check disk (loadSequenceFromDisk has fuzzy matching built in)
    const sequence = await recorder.loadSequenceFromDisk(args.name);

    if (!sequence) {
      const savedSequences = await recorder.listSavedSequencesOnDisk();
      const availableNames = [
        ...memorySequences.map(s => s.name),
        ...savedSequences.map(s => s.name)
      ].join(', ');
      return {
        success: false,
        error: `No sequence found matching "${args.name}". Available: ${availableNames || 'none'}`,
        errorCode: 'SEQUENCE_NOT_FOUND'
      };
    }

    await debugLog('executor', `Loaded sequence "${sequence.name}" via fuzzy match for "${args.name}"`);
    return { success: true, sequence };
  }

  return {
    success: false,
    error: 'Either "name" or "sequenceId" parameter is required.',
    errorCode: 'MISSING_PARAMETER',
    templateVars: { missing: 'name or sequenceId' }
  };
}

// =============================================================================
// Connection Analysis
// =============================================================================

/**
 * Analyze sequence commands to find launchChrome and determine connection requirements
 */
export function analyzeSequenceConnections(commands: RecordedCommand[]): ConnectionAnalysis {
  let launchChromeIndex = -1;
  let firstConnectionToolIndex = -1;

  for (let i = 0; i < commands.length; i++) {
    if (commands[i].tool === 'launchChrome' && launchChromeIndex === -1) {
      launchChromeIndex = i;
    }
    if (TOOLS_NEEDING_CONNECTION.includes(commands[i].tool) && firstConnectionToolIndex === -1) {
      firstConnectionToolIndex = i;
    }
  }

  const hasLaunchBeforeConnection = launchChromeIndex !== -1 &&
    (firstConnectionToolIndex === -1 || launchChromeIndex < firstConnectionToolIndex);

  return { launchChromeIndex, firstConnectionToolIndex, hasLaunchBeforeConnection };
}

/**
 * Extract connectionReason from sequence's launchChrome command if present
 */
export function extractConnectionFromSequence(
  commands: RecordedCommand[],
  analysis: ConnectionAnalysis
): string | undefined {
  if (analysis.hasLaunchBeforeConnection) {
    const launchParams = commands[analysis.launchChromeIndex].params;
    if (launchParams.reference) {
      return sanitizeReference(launchParams.reference);
    }
  }
  return undefined;
}

/**
 * Check if sequence needs a connection
 */
export function sequenceNeedsConnection(commands: RecordedCommand[]): boolean {
  return commands.some(cmd =>
    TOOLS_NEEDING_CONNECTION.includes(cmd.tool) && !cmd.params.connectionReason
  );
}

// =============================================================================
// Connection Management
// =============================================================================

/**
 * Check if debugger is paused and return breakpoint info if so
 */
export async function checkIfPaused(
  ctx: ExecutionContext
): Promise<BreakpointHitInfo | null> {
  const { executeToolCall, connectionReason, logPrefix = 'executor' } = ctx;

  if (!connectionReason) return null;

  try {
    const callStackResult = await executeToolCall('inspect', {
      action: 'getCallStack',
      connectionReason
    });

    const callStackText = callStackResult?.content?.[0]?.text || '';
    const isPaused = callStackText.includes('callFrameId') && !callStackText.includes('Not paused');

    if (isPaused) {
      // Extract pause location from call stack - try header format first, then JSON
      let url = 'unknown';
      let lineNumber = 0;
      let columnNumber: number | undefined;
      let functionName: string | undefined;

      // Try header format: "Paused at: http://localhost:3101/client.js:6"
      const pausedAtMatch = callStackText.match(/Paused at:\s*([^:\s]+):(\d+)/);
      if (pausedAtMatch) {
        url = pausedAtMatch[1];
        lineNumber = parseInt(pausedAtMatch[2], 10);
      }

      // Try JSON format for more details
      const sourceMatch = callStackText.match(/"source":\s*"([^"]+)"/);
      const lineMatch = callStackText.match(/"line":\s*(\d+)/);
      const colMatch = callStackText.match(/"column":\s*(\d+)/);
      const funcMatch = callStackText.match(/"functionName":\s*"([^"]+)"/);

      if (sourceMatch) url = sourceMatch[1];
      if (lineMatch) lineNumber = parseInt(lineMatch[1], 10);
      if (colMatch) columnNumber = parseInt(colMatch[1], 10);
      if (funcMatch && funcMatch[1]) functionName = funcMatch[1];

      return { url, lineNumber, columnNumber, functionName };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if debugger is paused and auto-resume if so
 */
export async function resumeIfPaused(
  ctx: ExecutionContext
): Promise<void> {
  const { executeToolCall, connectionReason, logPrefix = 'executor' } = ctx;

  if (!connectionReason) return;

  const pauseInfo = await checkIfPaused(ctx);
  if (pauseInfo) {
    debugLog(logPrefix, `Debugger is paused at ${pauseInfo.url}:${pauseInfo.lineNumber}, auto-resuming`);
    try {
      await executeToolCall('execution', {
        action: 'resume',
        connectionReason
      });
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch {
      // Ignore resume errors
    }
  }
}

// =============================================================================
// Auto-Launch Helper
// =============================================================================

export type AutoLaunchResult = {
  success: true;
} | {
  success: false;
  error: string;
  errorType: 'INVALID_REFERENCE' | 'LAUNCH_FAILED';
};

/**
 * Validate reference and auto-launch Chrome if needed.
 * This is the shared helper for all auto-launch scenarios.
 */
export async function autoLaunchChrome(
  executeToolCall: (toolName: string, params: Record<string, any>) => Promise<any>,
  connectionReason: string,
  logPrefix: string = 'auto-launch',
  forceNewInstance: boolean = false
): Promise<AutoLaunchResult> {
  // Validate connectionReason before launch (throws InvalidReferenceError if invalid)
  requireValidReference(connectionReason);

  await debugLog(logPrefix, `Auto-launching Chrome with reference: ${connectionReason} (forceNewInstance=${forceNewInstance})`);
  const launchResult = await executeToolCall('launchChrome', { reference: connectionReason, forceNewInstance });

  if (launchResult?.isError) {
    const errorText = launchResult?.content?.[0]?.text || 'Unknown error';
    return {
      success: false,
      error: `Failed to auto-launch Chrome: ${errorText}`,
      errorType: 'LAUNCH_FAILED'
    };
  }

  await debugLog(logPrefix, `Chrome launched successfully with reference: ${connectionReason}`);
  return { success: true };
}

/**
 * Ensure a connection is available, auto-launching Chrome if needed
 */
export async function ensureConnection(
  ctx: ExecutionContext,
  needsConnection: boolean,
  hasLaunchBeforeConnection: boolean
): Promise<{ success: true; didAutoLaunch: boolean } | { success: false; error: string }> {
  const { executeToolCall, connectionReason, logPrefix = 'executor' } = ctx;

  if (!needsConnection || hasLaunchBeforeConnection) {
    return { success: true, didAutoLaunch: false };
  }

  try {
    await debugLog(logPrefix, `Checking connection: ${connectionReason}`);
    const infoResult = await executeToolCall('navigate', { action: 'info', connectionReason });
    // Check if navigate returned an error response (doesn't throw, returns isError: true)
    if (infoResult?.isError) {
      throw new Error('Connection not active');
    }
    await debugLog(logPrefix, `Connection ${connectionReason} is active`);

    // Auto-resume if paused at a breakpoint
    await resumeIfPaused(ctx);

    return { success: true, didAutoLaunch: false };
  } catch {
    await debugLog(logPrefix, `Connection ${connectionReason} not active, launching Chrome...`);
    // Sequence runs always get a fresh Chrome process, not a tab in an existing one
    const launchResult = await autoLaunchChrome(executeToolCall, connectionReason, logPrefix, true);
    if (!launchResult.success) {
      return { success: false, error: launchResult.error };
    }
    return { success: true, didAutoLaunch: true };
  }
}

/**
 * Check if a URL's port is open (for localhost URLs only)
 * Returns success if port is open or URL is not localhost
 */
export async function checkPortBeforeNavigation(
  url: string,
  logPrefix: string = 'executor'
): Promise<{ success: true } | { success: false; error: string }> {
  const portCheck = await checkUrlPort(url, 2000);

  // null means non-localhost URL - skip check
  if (portCheck === null) {
    return { success: true };
  }

  if (!portCheck.open) {
    const error = `Port ${portCheck.port} is not open on ${portCheck.host}`;
    await debugLog(logPrefix, error);
    return { success: false, error };
  }

  await debugLog(logPrefix, `Port ${portCheck.port} is open on ${portCheck.host}`);
  return { success: true };
}

/**
 * Navigate to startUrl if sequence has one and doesn't start with navigate
 */
export async function navigateToStartUrl(
  ctx: ExecutionContext,
  sequence: CommandSequence,
  analysis: ConnectionAnalysis
): Promise<{ success: true } | { success: false; error: string }> {
  const { executeToolCall, connectionReason, logPrefix = 'executor' } = ctx;

  if (!sequence.startUrl || !connectionReason) {
    return { success: true };
  }

  const commands = sequence.commands;
  const firstNavigateIndex = commands.findIndex(cmd =>
    cmd.tool === 'navigate' && cmd.params.action === 'goto'
  );
  const startsWithNavigate = firstNavigateIndex === 0 ||
    (analysis.hasLaunchBeforeConnection && firstNavigateIndex === analysis.launchChromeIndex + 1);

  if (startsWithNavigate) {
    return { success: true };
  }

  // Check if port is open before navigating (localhost only)
  const portCheck = await checkPortBeforeNavigation(sequence.startUrl, logPrefix);
  if (!portCheck.success) {
    return portCheck;
  }

  await debugLog(logPrefix, `Auto-navigating to startUrl: ${sequence.startUrl}`);
  try {
    await executeToolCall('navigate', {
      action: 'goto',
      url: sequence.startUrl,
      connectionReason
    });
    await debugLog(logPrefix, `Navigated to startUrl: ${sequence.startUrl}`);
    return { success: true };
  } catch (navError: any) {
    return {
      success: false,
      error: `Failed to navigate to startUrl: ${navError.message}`
    };
  }
}

// =============================================================================
// Command Execution
// =============================================================================

/**
 * Execute a single command with retry logic for element not found errors
 */
export async function executeCommandWithRetry(
  executeToolCall: (toolName: string, params: Record<string, any>) => Promise<any>,
  tool: string,
  params: Record<string, any>,
  logPrefix: string = 'executor'
): Promise<{ success: boolean; result?: any; error?: string }> {
  const isRetryableAction = tool === 'input' && ['click', 'type', 'hover'].includes(params.action);
  const maxRetries = isRetryableAction ? 5 : 1;
  const retryDelayMs = 500;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // executeToolCall (index.ts) THROWS a ToolError when a tool returns an error
    // response (result.isError), so a tool error arrives here as an exception, not
    // a returned value. Handle BOTH: the catch is what actually drives element-not-
    // found retries (e.g. an async-rendered button that hasn't mounted yet); the
    // returned-isError branch is kept defensively in case a caller doesn't throw.
    let result: any;
    try {
      result = await executeToolCall(tool, params);
    } catch (err: any) {
      const errorText = err?.response?.content?.[0]?.text || err?.message || '';
      const isElementNotFound = errorText.includes('Element not found') ||
                                errorText.includes('not found') ||
                                errorText.includes('No element matches');

      if (isRetryableAction && isElementNotFound && attempt < maxRetries) {
        debugLog(logPrefix, `Element not found, retrying... (attempt ${attempt}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
        continue;
      }
      return { success: false, error: errorText.split('\n')[0] || 'Unknown error' };
    }

    if (result && result.isError) {
      const errorText = result.content?.[0]?.text || '';
      const isElementNotFound = errorText.includes('Element not found') ||
                                errorText.includes('not found') ||
                                errorText.includes('No element matches');

      if (isRetryableAction && isElementNotFound && attempt < maxRetries) {
        debugLog(logPrefix, `Element not found, retrying... (attempt ${attempt}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
        continue;
      }
      return { success: false, error: errorText.split('\n')[0] || 'Unknown error' };
    }

    return { success: true, result };
  }

  return { success: false, error: 'Max retries exceeded' };
}

/**
 * Validate that navigation succeeded (page loaded correctly)
 */
export async function validateNavigation(
  ctx: ExecutionContext,
  expectedUrl?: string
): Promise<{ success: boolean; error?: string }> {
  const { executeToolCall, connectionReason, logPrefix = 'executor' } = ctx;

  try {
    const infoResult = await executeToolCall('navigate', {
      action: 'info',
      connectionReason
    });

    const infoText = infoResult?.content?.[0]?.text || '';

    // Check for common error patterns
    if (infoText.includes('about:blank') && expectedUrl && !expectedUrl.includes('about:blank')) {
      return { success: false, error: 'Page failed to load (stuck on about:blank)' };
    }

    // Check for Chrome error pages
    if (infoText.includes('chrome-error://') || infoText.includes('ERR_')) {
      const errMatch = infoText.match(/(ERR_[A-Z_]+)/);
      return { success: false, error: `Page failed to load: ${errMatch?.[1] || 'connection error'}` };
    }

    // Check title for error indicators
    const titleMatch = infoText.match(/\*\*Title:\*\*\s*([^\n]+)/);
    const title = titleMatch?.[1]?.toLowerCase() || '';
    if (title.includes("site can't be reached") || title.includes("this site can't be reached")) {
      return { success: false, error: 'Site cannot be reached' };
    }

    debugLog(logPrefix, `Navigation validated successfully`);
    return { success: true };
  } catch (err: any) {
    debugLog(logPrefix, `Navigation validation failed: ${err.message}`);
    return { success: false, error: `Could not validate navigation: ${err.message}` };
  }
}

/**
 * Wait for an element to appear
 */
export async function waitForElement(
  ctx: ExecutionContext,
  selector: string
): Promise<void> {
  const { executeToolCall, connectionReason, logPrefix = 'executor' } = ctx;

  debugLog(logPrefix, `Waiting for element: ${selector}`);

  let retries = 5;
  while (retries > 0) {
    try {
      const result = await executeToolCall('dom', {
        action: 'querySelector',
        selector,
        connectionReason
      });

      if (result && !result.isError) {
        debugLog(logPrefix, `Element ${selector} found`);
        return;
      }
    } catch {
      // Ignore errors during wait
    }

    retries--;
    if (retries > 0) {
      debugLog(logPrefix, `Element ${selector} not found, waiting... (${retries} retries left)`);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  debugLog(logPrefix, `Warning: Element ${selector} not found after waiting`);
}

/**
 * Validate typed text was entered correctly
 */
export async function validateTypedText(
  ctx: ExecutionContext,
  selector: string,
  expectedText: string,
  append: boolean = false
): Promise<void> {
  const { executeToolCall, connectionReason, logPrefix = 'executor' } = ctx;

  debugLog(logPrefix, `Validating typed text in ${selector}${append ? ' (append mode)' : ''}`);

  try {
    await new Promise(resolve => setTimeout(resolve, 100));

    // Check .value for inputs/textareas, fall back to .innerText for contenteditable elements (e.g., ProseMirror)
    const evalResult = await executeToolCall('inspect', {
      action: 'evaluateExpression',
      expression: `(() => {
        const el = document.querySelector('${selector.replace(/'/g, "\\'")}');
        if (!el) return '';
        // For input/textarea, use .value
        if (el.value !== undefined && el.value !== '') return el.value;
        // For contenteditable (ProseMirror, etc.), use innerText
        if (el.isContentEditable || el.contentEditable === 'true') return el.innerText?.trim() || '';
        return el.value || '';
      })()`,
      connectionReason
    });

    let actualValue = '';
    if (evalResult?.content?.[0]?.text) {
      const codeBlockMatch = evalResult.content[0].text.match(/```(?:json)?\n([\s\S]*?)\n```/);
      if (codeBlockMatch) {
        actualValue = codeBlockMatch[1].trim();
        if (actualValue.startsWith('"') && actualValue.endsWith('"')) {
          actualValue = JSON.parse(actualValue);
        }
      }
    }

    // In append mode, check if the field ends with the expected text
    // In replace mode, check for exact match
    if (append) {
      if (!actualValue.endsWith(expectedText)) {
        debugLog(logPrefix, `Text validation failed (append): expected to end with "${expectedText}", got "${actualValue}"`);
        throw new Error(`Text validation failed for ${selector}: expected to end with "${expectedText}", got "${actualValue}"`);
      }
    } else {
      if (actualValue !== expectedText) {
        debugLog(logPrefix, `Text validation failed: expected "${expectedText}", got "${actualValue}"`);
        throw new Error(`Text validation failed for ${selector}: expected "${expectedText}", got "${actualValue}"`);
      }
    }

    debugLog(logPrefix, `Text validated: "${actualValue}" ${append ? 'ends with' : 'matches'} expected`);
  } catch (error: any) {
    if (error.message?.includes('Text validation failed')) {
      throw error;
    }
    debugLog(logPrefix, `Warning: Could not validate typed text: ${error}`);
  }
}

// =============================================================================
// Click Validation
// =============================================================================

export interface PreClickState {
  consoleErrorCount: number;
  consoleWarnCount: number;
  consoleTotalCount: number;
  networkRequestCount: number;
  url: string;
}

export interface ClickValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  info: string[];
}

/**
 * Capture pre-click state for delta comparison
 */
export async function capturePreClickState(ctx: ExecutionContext): Promise<PreClickState> {
  const { executeToolCall, connectionReason, logPrefix = 'executor' } = ctx;

  let consoleErrorCount = 0;
  let consoleWarnCount = 0;
  let consoleTotalCount = 0;
  let networkRequestCount = 0;
  let url = '';

  try {
    // Get console counts via _meta
    const consoleResult = await executeToolCall('console', {
      action: 'list', limit: 1, connectionReason
    });
    consoleErrorCount = consoleResult?._meta?.console?.errorCount || 0;
    consoleWarnCount = consoleResult?._meta?.console?.warnCount || 0;
    consoleTotalCount = consoleResult?._meta?.console?.totalCount || 0;
  } catch {
    debugLog(logPrefix, 'Warning: Could not get pre-click console state');
  }

  try {
    // Get network request count via _meta
    const networkResult = await executeToolCall('network', {
      action: 'list', limit: 1, connectionReason
    });
    networkRequestCount = networkResult?._meta?.network?.totalCount || 0;
  } catch {
    debugLog(logPrefix, 'Warning: Could not get pre-click network state');
  }

  try {
    // Get current URL via _meta
    const pageResult = await executeToolCall('navigate', {
      action: 'info', connectionReason
    });
    url = pageResult?._meta?.navigate?.url || '';
  } catch {
    debugLog(logPrefix, 'Warning: Could not get pre-click URL');
  }

  return { consoleErrorCount, consoleWarnCount, consoleTotalCount, networkRequestCount, url };
}

/**
 * Validate click action results
 */
export async function validateClickAction(
  ctx: ExecutionContext,
  preState: PreClickState,
  clickResult: any,
  config: ClickValidationConfig
): Promise<ClickValidationResult> {
  const { executeToolCall, connectionReason, logPrefix = 'executor' } = ctx;
  const errors: string[] = [];
  const warnings: string[] = [];
  const info: string[] = [];

  // Get structured data from _meta
  const clickMeta: ClickActionMeta | undefined = clickResult?._meta?.click;

  // Small delay before validation
  if (config.postClickDelayMs > 0) {
    await new Promise(r => setTimeout(r, config.postClickDelayMs));
  }

  // 1. Check if click had any effect (DOM changes)
  if (config.requireDomChanges && clickMeta?.domChanges) {
    if (clickMeta.domChanges.mutationCount === 0) {
      const msg = 'Click had no DOM effect (0 mutations)';
      if (config.domChangesFailMode === 'error') {
        errors.push(msg);
      } else {
        warnings.push(msg);
      }
    }
  }

  // 2. Check for navigation and validate it
  if (config.validateNavigation && clickMeta?.navigationOccurred) {
    const navResult = await validateNavigation(ctx);
    if (!navResult.success) {
      errors.push(`Navigation failed: ${navResult.error}`);
    }
  }

  // 3. Check for new console messages
  try {
    const consoleResult = await executeToolCall('console', {
      action: 'list', limit: 1, connectionReason
    });
    const newErrorCount = consoleResult?._meta?.console?.errorCount || 0;
    const newWarnCount = consoleResult?._meta?.console?.warnCount || 0;
    const newTotalCount = consoleResult?._meta?.console?.totalCount || 0;

    // Report new errors (respecting failOnConsoleErrors config)
    if (config.failOnConsoleErrors && newErrorCount > preState.consoleErrorCount) {
      const diff = newErrorCount - preState.consoleErrorCount;
      const msg = `${diff} new console error(s) after click`;
      if (config.consoleErrorsFailMode === 'error') {
        errors.push(msg);
      } else {
        warnings.push(msg);
      }
    }

    // Report new warnings as info
    if (newWarnCount > preState.consoleWarnCount) {
      const diff = newWarnCount - preState.consoleWarnCount;
      info.push(`${diff} new console warning(s)`);
    }

    // Report other new messages (log/info) as info
    const newLogInfoCount = (newTotalCount - newErrorCount - newWarnCount) -
                            (preState.consoleTotalCount - preState.consoleErrorCount - preState.consoleWarnCount);
    if (newLogInfoCount > 0) {
      info.push(`${newLogInfoCount} new console log(s)`);
    }
  } catch {
    debugLog(logPrefix, 'Warning: Could not check console after click');
  }

  // 4. Check for network request failures
  if (config.validateNetworkPayload) {
    try {
      const networkResult = await executeToolCall('network', {
        action: 'list', connectionReason
      });
      const newCount = networkResult?._meta?.network?.totalCount || 0;
      if (newCount > preState.networkRequestCount) {
        // Check for failed POST requests
        const failedResult = await executeToolCall('network', {
          action: 'search', method: 'POST', statusCode: '4', connectionReason
        });
        const failedCount = failedResult?._meta?.network?.matchCount || 0;
        if (failedCount > 0) {
          const msg = 'POST request returned 4xx error';
          if (config.networkFailMode === 'error') {
            errors.push(msg);
          } else {
            warnings.push(msg);
          }
        }
      }
    } catch {
      debugLog(logPrefix, 'Warning: Could not check network after click');
    }
  }

  // Log validation result
  if (errors.length > 0) {
    debugLog(logPrefix, `Click validation failed: ${errors.join('; ')}`);
  } else if (warnings.length > 0) {
    debugLog(logPrefix, `Click validation warnings: ${warnings.join('; ')}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    info
  };
}

/**
 * Gather diagnostic information after a failure
 */
async function gatherDiagnostics(ctx: ExecutionContext): Promise<string> {
  const { executeToolCall, connectionReason } = ctx;

  if (!connectionReason) return '';

  try {
    const consoleResult = await executeToolCall('console', {
      action: 'list',
      type: 'error',
      connectionReason
    });
    const consoleText = consoleResult?.content?.[0]?.text || '';
    const errorCount = (consoleText.match(/\*\*error\*\*/gi) || []).length;

    const networkResult = await executeToolCall('network', {
      action: 'search',
      statusCode: '4',
      connectionReason
    });
    const networkText = networkResult?.content?.[0]?.text || '';
    const failedRequests = (networkText.match(/\d{3}/g) || [])
      .filter((s: string) => s.startsWith('4') || s.startsWith('5')).length;

    const interactiveResult = await executeToolCall('content', {
      action: 'findInteractive',
      connectionReason
    });
    const interactiveText = interactiveResult?.content?.[0]?.text || '';
    const interactiveMatch = interactiveText.match(/Total: (\d+)/);
    const interactiveCount = interactiveMatch ? interactiveMatch[1] : 'unknown';

    return ` | Page state: ${interactiveCount} interactive elements, ${errorCount} console errors, ${failedRequests} failed requests`;
  } catch {
    return '';
  }
}

// =============================================================================
// Main Execution Loop
// =============================================================================

export interface ExecuteStepsOptions {
  sequence: CommandSequence;
  startStep: number;
  endStep?: number; // undefined = run to completion
  ctx: ExecutionContext;
  variables?: Record<string, string>;
  record?: boolean;
  stepTimeout?: number;
  totalTimeout?: number;
  overrideConnectionReason?: string;
  abortSignal?: AbortSignal;
}

/**
 * Execute a range of steps from a sequence
 */
export async function executeSteps(options: ExecuteStepsOptions): Promise<ExecutionResult> {
  const {
    sequence,
    startStep,
    endStep,
    ctx,
    variables,
    record,
    stepTimeout = 30000,
    totalTimeout = 300000,
    overrideConnectionReason,
    abortSignal
  } = options;

  const { executeToolCall, commandRecorder, connectionReason, logPrefix = 'executor' } = ctx;
  const commands = sequence.commands;
  const targetEnd = endStep ?? commands.length;
  const results: StepResult[] = [];
  const startTime = Date.now();

  // {{timestamp}} must be stable across every step of a run (including a
  // later step/finish call), not recomputed per-step - cache once on ctx.
  const runTimestamp = ctx.runTimestamp ?? (ctx.runTimestamp = Date.now());

  // Track breakpoints set during this sequence run (url:line format)
  const expectedBreakpoints: Set<string> = new Set();

  // Auto-resume if debugger is paused from a previous run
  if (connectionReason && startStep === 0) {
    await resumeIfPaused(ctx);
  }

  // Timeout helper
  const executeWithTimeout = async <T>(
    promise: Promise<T>,
    timeoutMs: number,
    timeoutMessage: string
  ): Promise<T> => {
    let timeoutId: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutId!);
    }
  };

  // Abortable delay helper - properly cleans up listeners
  const abortableDelay = (ms: number): Promise<boolean> => {
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => resolve(false), ms);
      if (abortSignal) {
        const onAbort = () => {
          clearTimeout(timeoutId);
          resolve(true); // true = was aborted
        };
        abortSignal.addEventListener('abort', onAbort, { once: true });
        // Clean up listener if timeout completes normally
        setTimeout(() => {
          abortSignal.removeEventListener('abort', onAbort);
        }, ms + 1);
      }
    });
  };

  for (let i = startStep; i < targetEnd; i++) {
    const cmd = commands[i];

    // Check if aborted
    if (abortSignal?.aborted) {
      debugLog(logPrefix, `Replay aborted at step ${i + 1}`);
      results.push({
        step: i + 1,
        tool: cmd.tool,
        success: false,
        error: 'Replay aborted by user'
      });
      break;
    }

    // Check total timeout
    const elapsed = Date.now() - startTime;
    if (elapsed >= totalTimeout) {
      debugLog(logPrefix, `Total timeout exceeded after ${elapsed}ms`);
      results.push({
        step: i + 1,
        tool: cmd.tool,
        success: false,
        error: `Total timeout exceeded (${totalTimeout}ms)`
      });
      break;
    }

    const remainingTotal = totalTimeout - elapsed;
    const effectiveStepTimeout = Math.min(stepTimeout, remainingTotal);

    // Wait for delay if specified (for recorded interactions)
    if (cmd.delay && cmd.delay > 0) {
      debugLog(logPrefix, `Waiting ${cmd.delay}ms before step ${i + 1}`);
      const wasAborted = await abortableDelay(cmd.delay);
      if (wasAborted) continue;
    }

    try {
      // Log comment if present
      if (cmd.comment) {
        debugLog(logPrefix, `Comment: ${cmd.comment}`);
      }
      debugLog(logPrefix, `Executing step ${i + 1}/${commands.length}: ${cmd.tool}`);

      // Build params
      let params = { ...cmd.params };

      // Resolve {{var:name.path}} / {{timestamp}} tokens against the run's
      // variable store. Throws InterpolationError on an unresolvable token -
      // caught by this step's try/catch below, same as any other step failure.
      params = interpolateParams(params, ctx.variableStore ?? {}, runTimestamp);

      // Apply variable substitutions
      if (variables && cmd.tool === 'input' && params.action === 'type' && params.text) {
        const varName = `var_${i}_${params.selector?.replace(/[^a-zA-Z0-9]/g, '_') || 'text'}`;
        if (variables[varName] !== undefined) {
          params.text = variables[varName];
          debugLog(logPrefix, `Substituted ${varName}: "${params.text}"`);
        }
      }

      // Inject connectionReason for tools that need it
      if (connectionReason && TOOLS_NEEDING_CONNECTION.includes(cmd.tool) && !cmd.params.connectionReason) {
        params.connectionReason = connectionReason;
      }

      // request({ destination: 'browser' }) needs a connectionReason too, but request
      // is deliberately NOT in TOOLS_NEEDING_CONNECTION (destination:'node' sequences
      // must not force a Chrome auto-launch)
      if (cmd.tool === 'request' && params.destination === 'browser' && !params.connectionReason && connectionReason) {
        params.connectionReason = connectionReason;
      }

      // Override launchChrome reference if custom connectionReason provided
      if (cmd.tool === 'launchChrome' && overrideConnectionReason) {
        params.reference = overrideConnectionReason;
      }

      // Handle stale callFrameId for getVariables
      if (cmd.tool === 'inspect' && params.action === 'getVariables' && params.callFrameId && connectionReason) {
        debugLog(logPrefix, `Refreshing stale callFrameId`);
        try {
          const callStackResult = await executeToolCall('inspect', {
            action: 'getCallStack',
            connectionReason
          });
          const callStackText = callStackResult?.content?.[0]?.text || '';
          const callFrameIdMatch = callStackText.match(/"callFrameId":\s*"([^"]+)"/);
          if (callFrameIdMatch?.[1]) {
            params.callFrameId = callFrameIdMatch[1];
          }
        } catch (err: any) {
          debugLog(logPrefix, `Warning: Failed to get fresh callFrameId: ${err.message}`);
        }
      }

      // Check port before navigate goto (localhost only)
      if (cmd.tool === 'navigate' && params.action === 'goto' && params.url) {
        const portCheck = await checkPortBeforeNavigation(params.url, logPrefix);
        if (!portCheck.success) {
          results.push({
            step: i + 1,
            tool: cmd.tool,
            success: false,
            error: portCheck.error
          });
          break;
        }
      }

      // Replay cursor visual feedback
      if (cmd.tool === 'input') {
        if (params.action === 'click' && typeof params.x === 'number' && typeof params.y === 'number') {
          // Coordinate-based click - show cursor effect
          if (replayCursorCallbacks.onClickBefore) {
            await replayCursorCallbacks.onClickBefore(params.x, params.y, false);
          }
        } else if (params.action === 'press' && params.key) {
          // Key press - show key indicator
          if (replayCursorCallbacks.onKeyPress) {
            await replayCursorCallbacks.onKeyPress(params.key);
          }
        }
      }

      // Handle conditional command specially
      if (cmd.tool === 'conditional') {
        // Validate required parameters
        if (!params.if || typeof params.if !== 'string') {
          results.push({
            step: i + 1,
            tool: cmd.tool,
            success: false,
            error: 'Conditional command requires "if" parameter with a condition string. Expected format: {{selector:.class}}, {{url:contains:text}}, {{cookie:name}}, or {{localStorage:key}}'
          });
          break;
        }
        if (!params.then || typeof params.then !== 'string') {
          results.push({
            step: i + 1,
            tool: cmd.tool,
            success: false,
            error: 'Conditional command requires "then" parameter with the sequence name to execute when condition is met'
          });
          break;
        }

        const condResult = await executeConditionalFlow(
          params.if,
          params.then,
          ctx,
          commandRecorder
        );

        // Build the step result with substeps
        const stepResult: StepResult = {
          step: i + 1,
          tool: cmd.tool,
          success: condResult.success,
          sequenceName: condResult.sequenceName,
          conditionMet: condResult.executed,
          substeps: condResult.substeps,
          error: condResult.error
        };

        results.push(stepResult);

        if (!condResult.success) {
          break;
        }

        const substepCount = condResult.substeps?.length || 0;
        debugLog(logPrefix, `Step ${i + 1} completed: conditional ${condResult.executed ? `ran ${substepCount} substeps` : 'skipped (condition not met)'}`);
        continue; // Skip the regular execution path
      }

      // Capture pre-click state for validation
      let preClickState: PreClickState | null = null;
      const clickConfig = configManager.getClickValidationConfig();
      if (cmd.tool === 'input' && params.action === 'click' && connectionReason && clickConfig.enabled) {
        preClickState = await capturePreClickState(ctx);
      }

      // Execute with retry
      const execResult = await executeCommandWithRetry(executeToolCall, cmd.tool, params, logPrefix);

      if (!execResult.success) {
        const diagnostics = await gatherDiagnostics(ctx);
        results.push({
          step: i + 1,
          tool: cmd.tool,
          success: false,
          error: `${execResult.error}${diagnostics}`
        });
        break;
      }

      // Track breakpoints set by this sequence
      // Due to CDP line number handling (0-based vs 1-based) and resolution to nearest valid line,
      // we track the requested line and ±1 variants to handle edge cases
      if (cmd.tool === 'breakpoint' && params.action === 'set' && params.url) {
        const requestedLine = params.lineNumber;

        // Try to get the actual resolved line from the response
        // Format: "Breakpoint set at URL:LINE" or "CDP resolved to line LINE"
        const responseText = execResult.result?.content?.[0]?.text || '';
        const setAtMatch = responseText.match(/Breakpoint set at [^:]+:(\d+)/);
        const resolvedMatch = responseText.match(/CDP resolved to line (\d+)/);
        const reportedLine = resolvedMatch
          ? parseInt(resolvedMatch[1], 10)
          : setAtMatch
            ? parseInt(setAtMatch[1], 10)
            : requestedLine;

        // Track the reported line
        expectedBreakpoints.add(`${params.url}:${reportedLine}`);
        debugLog(logPrefix, `Tracking expected breakpoint: ${params.url}:${reportedLine}`);

        // Also track ±1 to handle 0-based/1-based conversion edge cases
        expectedBreakpoints.add(`${params.url}:${reportedLine - 1}`);
        expectedBreakpoints.add(`${params.url}:${reportedLine + 1}`);

        // Track requested line if different
        if (requestedLine !== reportedLine) {
          expectedBreakpoints.add(`${params.url}:${requestedLine}`);
          expectedBreakpoints.add(`${params.url}:${requestedLine - 1}`);
          expectedBreakpoints.add(`${params.url}:${requestedLine + 1}`);
        }

        debugLog(logPrefix, `Expected breakpoints for ${params.url}: ${[...expectedBreakpoints].filter(k => k.startsWith(params.url)).map(k => k.split(':').pop()).join(', ')}`);
      }

      // Post-step validation (before marking as success)
      if (cmd.tool === 'navigate' && connectionReason) {
        // Validate navigation succeeded
        const expectedUrl = params.action === 'goto' ? params.url : undefined;
        const navValidation = await validateNavigation(ctx, expectedUrl);
        if (!navValidation.success) {
          throw new Error(navValidation.error || 'Navigation failed');
        }
      }

      // Click validation (after successful execution)
      if (cmd.tool === 'input' && params.action === 'click' && connectionReason && preClickState && clickConfig.enabled) {
        const clickValidation = await validateClickAction(ctx, preClickState, execResult.result, clickConfig);

        // Log info messages (console activity)
        for (const infoMsg of clickValidation.info) {
          debugLog(logPrefix, `Click info: ${infoMsg}`);
        }

        // Log warnings
        for (const warn of clickValidation.warnings) {
          debugLog(logPrefix, `Click warning: ${warn}`);
        }

        // Handle errors - pause sequence for inspection/retry instead of failing
        if (!clickValidation.valid) {
          debugLog(logPrefix, `Click validation failed at step ${i + 1}, pausing for inspection`);

          // Mark this step as failed but allow retry
          results.push({
            step: i + 1,
            tool: cmd.tool,
            success: false,
            error: `Click validation: ${clickValidation.errors.join('; ')}`
          });

          return {
            results,
            totalCommands: commands.length,
            durationMs: Date.now() - startTime,
            pausedAtStep: i + 1,
            clickValidationFailure: {
              step: i + 1,
              selector: params.selector || 'unknown',
              errors: clickValidation.errors,
              warnings: clickValidation.warnings,
              info: clickValidation.info,
            }
          };
        }
      }

      // Record command if enabled (preserve delay and comment)
      if (record) {
        commandRecorder.recordCommand(cmd.tool, params, {
          delay: cmd.delay,
          comment: cmd.comment
        });
      }

      results.push({ step: i + 1, tool: cmd.tool, success: true });
      debugLog(logPrefix, `Step ${i + 1} completed successfully`);

      // Capture request({ saveAs }) result into the run's variable store
      if (cmd.tool === 'request' && params.saveAs && execResult.result?._meta?.request) {
        (ctx.variableStore ??= {})[params.saveAs] = execResult.result._meta.request;
        debugLog(logPrefix, `Captured variable "${params.saveAs}" from step ${i + 1}`);
      }

      // Check if we hit a breakpoint after this step
      if (connectionReason) {
        const breakpointInfo = await checkIfPaused(ctx);
        if (breakpointInfo) {
          const breakpointKey = `${breakpointInfo.url}:${breakpointInfo.lineNumber}`;
          const isExpected = expectedBreakpoints.has(breakpointKey);
          debugLog(logPrefix, `Breakpoint hit at ${breakpointKey} (expected: ${isExpected})`);

          if (isExpected) {
            // Expected breakpoint from this sequence - continue execution
            debugLog(logPrefix, `Expected breakpoint hit, continuing sequence`);
          } else {
            // Unexpected breakpoint - stop and return
            return {
              results,
              totalCommands: commands.length,
              durationMs: Date.now() - startTime,
              breakpointHit: breakpointInfo
            };
          }
        }
      }

      // Post-step async operations (after marking success)
      if (cmd.tool === 'input' && params.action === 'type' && params.selector && connectionReason) {
        await validateTypedText(ctx, params.selector, params.text || '', params.append === true);
      }

      // Pre-fetch next element after navigation/click
      const isNavigationAction = cmd.tool === 'navigate' ||
        (cmd.tool === 'input' && params.action === 'click');

      if (isNavigationAction && connectionReason && i + 1 < commands.length) {
        const nextCmd = commands[i + 1];
        if (nextCmd.tool === 'input' && nextCmd.params.selector) {
          await waitForElement(ctx, nextCmd.params.selector);
        }
      }

    } catch (error: any) {
      debugLog(logPrefix, `Error at step ${i + 1}: ${error.message}`);
      results.push({
        step: i + 1,
        tool: cmd.tool,
        success: false,
        error: error.message || 'Unknown error'
      });
      break;
    }
  }

  return {
    results,
    totalCommands: commands.length,
    durationMs: Date.now() - startTime
  };
}

/**
 * Execute a sequence with pause support (stepTo)
 */
export async function executeSequenceWithPause(
  options: ExecuteStepsOptions & { stepTo?: number }
): Promise<ExecutionResult> {
  const { sequence, ctx, stepTo } = options;
  const { commandRecorder, connectionReason } = ctx;

  const result = await executeSteps({
    ...options,
    endStep: stepTo
  });

  // If we stopped at stepTo and didn't fail, set up paused state
  if (stepTo !== undefined && result.results.length > 0) {
    const lastResult = result.results[result.results.length - 1];
    if (lastResult.success && lastResult.step >= stepTo) {
      const activeState: ActiveSequenceState = {
        sequenceId: sequence.id,
        sequenceName: sequence.name,
        connectionReason: connectionReason || '',
        currentStep: lastResult.step,
        totalSteps: sequence.commands.length,
        pausedAt: Date.now(),
        historyIndexAtPause: commandRecorder.getCurrentHistoryIndex(),
        capturedVariables: ctx.variableStore,
        runTimestamp: ctx.runTimestamp,
      };

      result.pausedAtStep = lastResult.step;
      result.activeSequenceState = activeState;
    }
  }

  return result;
}

// =============================================================================
// Debug State
// =============================================================================

export interface DebugState {
  isPaused: boolean;
  pauseLocation?: string;
  breakpointCount: number;
}

/**
 * Get current debug state (breakpoints, pause status)
 */
export async function getDebugState(ctx: ExecutionContext): Promise<DebugState | null> {
  const { executeToolCall, connectionReason, logPrefix = 'executor' } = ctx;

  if (!connectionReason) return null;

  try {
    const breakpointResult = await executeToolCall('breakpoint', {
      action: 'list',
      connectionReason
    });
    const breakpointText = breakpointResult?.content?.[0]?.text || '';
    const totalMatch = breakpointText.match(/\*\*Total:\*\*\s*(\d+)/);
    const breakpointCount = totalMatch ? parseInt(totalMatch[1], 10) : 0;

    const callStackResult = await executeToolCall('inspect', {
      action: 'getCallStack',
      connectionReason
    });
    const callStackText = callStackResult?.content?.[0]?.text || '';
    const isPaused = callStackText.includes('callFrameId') && !callStackText.includes('Not paused');

    let pauseLocation: string | undefined;
    if (isPaused) {
      const pauseLocationMatch = callStackText.match(/Paused at:\s*([^\n]+)/);
      pauseLocation = pauseLocationMatch ? pauseLocationMatch[1] : 'unknown location';
    }

    return { isPaused, pauseLocation, breakpointCount };
  } catch (err: any) {
    debugLog(logPrefix, `Could not get debug state: ${err.message}`);
    return null;
  }
}
