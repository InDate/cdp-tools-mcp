/**
 * Command Replay Tools - Action router for sequence recording and playback
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import { join } from 'path';
import type { CommandRecorder, ActiveSequenceState, CommandSequence } from '../command-recorder.js';
import { createTool } from '../validation-helpers.js';
import { createSuccessResponse, createErrorResponse } from '../messages.js';
import { showReplayOverlay } from '../interaction-recorder.js';
import { getIssue } from '../issue-tracker.js';
import { deriveConnectionReference } from '../reference-validator.js';

import {
  loadSequence,
  rebaseSequence,
  analyzeSequenceConnections,
  extractConnectionFromSequence,
  sequenceNeedsConnection,
  ensureConnection,
  navigateToStartUrl,
  executeSteps,
  executeSequenceWithPause,
  getDebugState,
  setReplayCursorCallbacks,
  injectReplayCursor,
  showClickEffect,
  showKeyPress,
  removeReplayCursor,
  autoLaunchChrome,
  TOOLS_NEEDING_CONNECTION,
  type ExecutionContext,
  type LoadSequenceResult,
} from './replay-executor.js';

// =============================================================================
// Step tool-name validation (bug-010)
// =============================================================================

/**
 * Step "tools" that the replay executor handles itself instead of dispatching
 * through the MCP tool map (see replay-executor.ts). These are always valid
 * step names even though they are not registered tools.
 */
const VIRTUAL_STEP_TOOLS = new Set(['conditional']);

/** Levenshtein distance, used only to suggest a likely intended tool name. */
function editDistance(a: string, b: string): number {
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      diag = tmp;
    }
  }
  return prev[b.length];
}

function suggestToolName(name: string, knownToolNames: string[]): string | undefined {
  const lower = name.toLowerCase();
  let best: { name: string; distance: number } | undefined;
  for (const known of knownToolNames) {
    const distance = editDistance(lower, known.toLowerCase());
    if (distance <= 3 && (!best || distance < best.distance)) {
      best = { name: known, distance };
    }
  }
  return best?.name;
}

export interface UnknownStepTool {
  /** 1-based step number, matching the numbering used in run results */
  step: number;
  tool: string;
  suggestion?: string;
}

/**
 * Find sequence steps whose `tool` is not a registered tool name.
 *
 * Only NAMES are validated - step params are deliberately not checked against
 * the tools' zod schemas, because params legitimately contain interpolation
 * tokens ({{var:...}}, {{timestamp}}) that are only substituted at run time,
 * so a number-typed field can validly hold a string token at rest.
 */
export function findUnknownStepTools(
  commands: Array<{ tool?: unknown }>,
  knownToolNames: string[]
): UnknownStepTool[] {
  const known = new Set(knownToolNames);
  const unknown: UnknownStepTool[] = [];

  commands.forEach((cmd, i) => {
    const name = typeof cmd?.tool === 'string' ? cmd.tool : String(cmd?.tool);
    if (known.has(name) || VIRTUAL_STEP_TOOLS.has(name)) return;
    unknown.push({ step: i + 1, tool: name, suggestion: suggestToolName(name, knownToolNames) });
  });

  return unknown;
}

/**
 * Build the error response for a sequence containing unknown tool names.
 * Uses a plain response rather than a message template because there is no
 * template for this case yet (see report for the suggested SEQUENCE_UNKNOWN_TOOL entry).
 */
function unknownStepToolsError(
  action: string,
  sequenceName: string,
  unknown: UnknownStepTool[],
  knownToolNames: string[]
) {
  const plural = unknown.length === 1 ? '' : 's';
  const lines: string[] = [
    `Error: Sequence "${sequenceName}" references ${unknown.length} unknown tool name${plural}`,
    `The "${action}" action was rejected before any step ran, so no browser state was changed.`,
    '',
  ];

  for (const u of unknown) {
    lines.push(
      `- Step ${u.step}: \`${u.tool}\` is not a known tool${u.suggestion ? ` - did you mean \`${u.suggestion}\`?` : ''}`
    );
  }

  lines.push('');
  lines.push('**Fix:** correct the `tool` field on the listed step(s).');
  lines.push(`**Known tools:** ${knownToolNames.slice().sort().join(', ')}`);

  return { content: [{ type: 'text', text: lines.join('\n') }], isError: true };
}

/**
 * Validate every step's tool name in a sequence. Returns an error response when
 * any name is unknown, or null when the sequence is fine (including when no
 * tool-name provider was supplied, which keeps validation opt-in).
 */
function validateSequenceToolNames(
  sequence: CommandSequence,
  action: string,
  getKnownToolNames?: () => string[]
) {
  if (!getKnownToolNames) return null;

  const knownToolNames = getKnownToolNames();
  if (!knownToolNames || knownToolNames.length === 0) return null;

  const unknown = findUnknownStepTools(sequence.commands ?? [], knownToolNames);
  if (unknown.length === 0) return null;

  return unknownStepToolsError(action, sequence.name, unknown, knownToolNames);
}

/**
 * Handle loadSequence error result - creates proper error response with template variables
 */
function handleLoadSequenceError(result: Extract<LoadSequenceResult, { success: false }>, action: string) {
  return createErrorResponse(result.errorCode, {
    action,
    message: result.error,
    ...result.templateVars
  });
}

import {
  formatExecutionResults,
  formatPausedResponse,
  formatDebugState,
  formatBreakpointHit,
  formatClickValidationFailure,
  extractTextVariables,
  formatVariablePrompt,
  formatHistory,
  formatSequenceCreated,
  formatSequenceList,
  formatSequenceDetails,
  formatSavedSequencesList,
  formatActiveStatus,
  formatStepResults,
  formatInsertPrompt,
  formatInsertResult,
} from './replay-formatters.js';

import { readHistoryLines, getHistoryFilePath } from '../debug-logger.js';
import {
  startRecording,
  eventsToCommands,
  generateCondensedTimeline,
  isCommentEvent,
  type CommentCategory,
  type CommentEvent,
} from '../interaction-recorder.js';

import {
  addIssue,
  initializeTracker,
  saveIssueSequence,
} from '../issue-tracker.js';

import { configManager } from '../config.js';

// =============================================================================
// Schema Definition
// =============================================================================

const replaySchema = z.object({
  action: z.enum([
    'history', 'create', 'list', 'get', 'delete',
    'export', 'load', 'listSaved', 'deleteSaved',
    'run', 'step', 'finish', 'insert', 'status', 'cancel',
    'repeat', 'runFromLog',
    'recordInteraction'
  ]),
  limit: z.number().optional().describe('Max items (default:50)'),
  name: z.string().optional(),
  description: z.string().optional(),
  expectedOutcome: z.string().optional(),
  startUrl: z.string().optional().describe('create: sequence start URL. run: replace the stored startUrl for this run only (e.g. a freshly minted link)'),
  baseUrl: z.string().optional().describe('run: retarget the sequence at another deployment — every absolute URL (startUrl + command params) keeps its path/query but takes this origin. Not preserved across a mid-run pause/step resume'),
  indices: z.array(z.number()).optional().describe('Command indices'),
  lines: z.array(z.number()).optional().describe('Log line numbers'),
  sequenceId: z.string().optional(),
  global: z.boolean().optional().describe('Use ~/.cdp-tools/'),
  format: z.enum(['sequence', 'playwright', 'puppeteer']).optional(),
  filename: z.string().optional(),
  intoHistory: z.boolean().optional(),
  connectionReason: z.string().optional(),
  record: z.boolean().optional(),
  variables: z.record(z.string()).optional(),
  stepTimeout: z.number().optional().describe('Per-step ms'),
  totalTimeout: z.number().optional().describe('Total ms'),
  startFrom: z.number().optional().describe('Start step (1-indexed)'),
  stepTo: z.number().optional().describe('Pause after step'),
  stepCount: z.number().optional().describe('Steps to run'),
  insertIndices: z.array(z.number()).optional(),
  insertAfterStep: z.number().optional(),
  overwrite: z.boolean().optional(),
  newName: z.string().optional(),
  showOverlay: z.boolean().optional(),
  simplifyEvents: z.boolean().optional().describe('recordInteraction: collapse noisy raw events (default:true)'),
  includeHovers: z.boolean().optional().describe('recordInteraction: keep mousemove steps (default:false)'),
  outputFormat: z.enum(['events', 'commands', 'puppeteer', 'playwright']).optional()
    .describe('get: commands|playwright|puppeteer. recordInteraction: events|commands (JSON dump appended to the summary)'),
  preferCoordinates: z.boolean().optional().describe('recordInteraction: emit x,y clicks instead of selectors (default:false)'),
  preferSelectors: z.boolean().optional().describe('recordInteraction: emit selector clicks even for canvas; wins over preferCoordinates (default:false)'),
  issueId: z.number().optional(),
  issueType: z.enum(['bug', 'feature']).optional(),
  issueTitle: z.string().optional(),
  showReplayOverlay: z.boolean().optional(),
  showAll: z.boolean().optional().describe('Show all sequences including completed/fixed issues'),
  killChromeOnFinish: z.boolean().optional().describe("run: kill the Chrome behind this run's own connection after finishing (skipped on pause/abort). Browsers a step connects to via its own connectionReason are left running - they may be instances you launched yourself."),
}).strict();

// =============================================================================
// Action Handlers
// =============================================================================

type ReplayArgs = z.infer<typeof replaySchema>;

async function handleHistory(args: ReplayArgs, recorder: CommandRecorder) {
  const limit = args.limit || 50;
  const history = recorder.getHistory(limit);
  const stats = recorder.getStats();

  // Mark history as viewed if we're in a paused sequence (enables insert)
  if (recorder.getActiveSequence()) {
    recorder.markHistoryViewed();
  }

  return { content: [{ type: 'text', text: formatHistory(history, stats.historyCount) }] };
}

async function handleRepeat(
  args: ReplayArgs,
  recorder: CommandRecorder,
  executeToolCall: (toolName: string, params: Record<string, any>) => Promise<any>
) {
  if (!args.indices || args.indices.length === 0) {
    return createErrorResponse('MISSING_PARAMETER', {
      action: 'repeat',
      missing: 'indices',
      message: 'The "repeat" action requires an "indices" array with command indices to execute'
    });
  }

  // Get commands from history
  const commands: Array<{ tool: string; params: Record<string, any>; index: number }> = [];
  for (const idx of args.indices) {
    const cmd = recorder.getCommand(idx);
    if (!cmd) {
      return createErrorResponse('INVALID_INDICES', {
        message: `Command index ${idx} not found in history. Use replay({ action: "history" }) to see available commands.`
      });
    }
    commands.push({ tool: cmd.tool, params: cmd.params, index: idx });
  }

  // Determine if we need a connection
  const needsConnection = commands.some(cmd => TOOLS_NEEDING_CONNECTION.includes(cmd.tool));
  let connectionReason = args.connectionReason;

  // Try to extract connection from commands if not provided
  if (!connectionReason && needsConnection) {
    // Check if any command creates a connection (launchChrome, connectDebugger)
    const launchCmd = commands.find(c => c.tool === 'launchChrome' || c.tool === 'connectDebugger');
    if (launchCmd && launchCmd.params.reference) {
      connectionReason = launchCmd.params.reference;
    }
  }

  if (!connectionReason && needsConnection) {
    return createErrorResponse('MISSING_PARAMETER', {
      action: 'repeat',
      missing: 'connectionReason',
      message: 'These commands require a browser connection. Provide connectionReason parameter.'
    });
  }

  // Execute commands
  const results: Array<{ index: number; tool: string; success: boolean; error?: string }> = [];
  const startTime = Date.now();

  for (const cmd of commands) {
    try {
      // Add connectionReason to params if needed
      const params = { ...cmd.params };
      if (connectionReason && TOOLS_NEEDING_CONNECTION.includes(cmd.tool)) {
        params.connectionReason = connectionReason;
      }

      await executeToolCall(cmd.tool, params);
      results.push({ index: cmd.index, tool: cmd.tool, success: true });
    } catch (error: any) {
      results.push({ index: cmd.index, tool: cmd.tool, success: false, error: error.message || String(error) });
      // Stop on first error
      break;
    }
  }

  const durationMs = Date.now() - startTime;
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;

  // Format response
  let response = failed > 0
    ? `**Repeat failed** at command #${results.find(r => !r.success)?.index}`
    : `**Repeated ${successful} command${successful !== 1 ? 's' : ''}** in ${(durationMs / 1000).toFixed(1)}s`;

  response += '\n';
  results.forEach(r => {
    const icon = r.success ? '✓' : '✗';
    response += `\n#${r.index}. **${r.tool}** ${icon}`;
    if (r.error) {
      response += ` - ${r.error}`;
    }
  });

  return { content: [{ type: 'text', text: response }] };
}

async function handleRunFromLog(
  args: ReplayArgs,
  executeToolCall: (toolName: string, params: Record<string, any>) => Promise<any>
) {
  if (!args.lines || args.lines.length === 0) {
    return createErrorResponse('MISSING_PARAMETER', {
      action: 'runFromLog',
      missing: 'lines',
      message: `The "runFromLog" action requires a "lines" array with line numbers to execute from history.log (1-indexed, line 1 is most recent). File: ${getHistoryFilePath()}`
    });
  }

  // Read commands from history.log file
  const lineResults = await readHistoryLines(args.lines);

  // Check for errors
  const errors = lineResults.filter((r): r is { line: number; error: string } => 'error' in r);
  if (errors.length > 0) {
    return createErrorResponse('INVALID_LINES', {
      message: `Some lines could not be read from history.log:\n${errors.map(e => `  Line ${e.line}: ${e.error}`).join('\n')}`,
      file: getHistoryFilePath()
    });
  }

  const commands = lineResults as Array<{ line: number; tool: string; params: Record<string, any> }>;

  // Determine if we need a connection
  const needsConnection = commands.some(cmd => TOOLS_NEEDING_CONNECTION.includes(cmd.tool));
  let connectionReason = args.connectionReason;

  // Try to extract connection from commands if not provided
  if (!connectionReason && needsConnection) {
    const launchCmd = commands.find(c => c.tool === 'launchChrome' || c.tool === 'connectDebugger');
    if (launchCmd && launchCmd.params.reference) {
      connectionReason = launchCmd.params.reference;
    }
  }

  if (!connectionReason && needsConnection) {
    return createErrorResponse('MISSING_PARAMETER', {
      action: 'runFromLog',
      missing: 'connectionReason',
      message: 'These commands require a browser connection. Provide connectionReason parameter.'
    });
  }

  // Execute commands
  const results: Array<{ line: number; tool: string; success: boolean; error?: string }> = [];
  const startTime = Date.now();

  for (const cmd of commands) {
    try {
      const params = { ...cmd.params };
      if (connectionReason && TOOLS_NEEDING_CONNECTION.includes(cmd.tool)) {
        params.connectionReason = connectionReason;
      }

      await executeToolCall(cmd.tool, params);
      results.push({ line: cmd.line, tool: cmd.tool, success: true });
    } catch (error: any) {
      results.push({ line: cmd.line, tool: cmd.tool, success: false, error: error.message || String(error) });
      break;
    }
  }

  const durationMs = Date.now() - startTime;
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;

  let response = failed > 0
    ? `**runFromLog failed** at line ${results.find(r => !r.success)?.line}`
    : `**Executed ${successful} command${successful !== 1 ? 's' : ''} from history.log** in ${(durationMs / 1000).toFixed(1)}s`;

  response += '\n';
  results.forEach(r => {
    const icon = r.success ? '✓' : '✗';
    response += `\nL${r.line}. **${r.tool}** ${icon}`;
    if (r.error) {
      response += ` - ${r.error}`;
    }
  });

  return { content: [{ type: 'text', text: response }] };
}

async function handleCreate(args: ReplayArgs, recorder: CommandRecorder, getKnownToolNames?: () => string[]) {
  if (!args.name) {
    return createErrorResponse('MISSING_PARAMETER', {
      action: 'create',
      missing: 'name',
      message: 'The "create" action requires a "name" parameter'
    });
  }

  if (!args.indices || args.indices.length === 0) {
    return createErrorResponse('MISSING_PARAMETER', {
      action: 'create',
      missing: 'indices',
      message: 'The "create" action requires an "indices" array with at least one command index'
    });
  }

  // Reject unknown tool names up front rather than failing mid-run (bug-010).
  // The check runs inside createSequence, on the candidate, BEFORE it replaces any
  // same-named sequence in memory - otherwise a bad create would delete the user's
  // good sequence and then reject the new one, leaving them with neither.
  let invalid: ReturnType<typeof validateSequenceToolNames> = null;
  const sequence = await recorder.createSequence(args.name, args.indices, {
    description: args.description,
    expectedOutcome: args.expectedOutcome,
    startUrl: args.startUrl,
    validate: (candidate) => {
      invalid = validateSequenceToolNames(candidate, 'create', getKnownToolNames);
      return invalid === null;
    },
  });

  if (invalid) return invalid;

  if (!sequence) {
    return createErrorResponse('INVALID_INDICES', {
      message: 'One or more command indices are invalid. Use replay({ action: "history" }) to see available commands.'
    });
  }

  return { content: [{ type: 'text', text: formatSequenceCreated(sequence) }] };
}

async function handleList(recorder: CommandRecorder) {
  const sequences = recorder.listSequences();
  return { content: [{ type: 'text', text: formatSequenceList(sequences) }] };
}

async function handleGet(args: ReplayArgs, recorder: CommandRecorder) {
  // Use loadSequence to support both name (disk) and sequenceId (memory)
  const loadResult = await loadSequence({ name: args.name, sequenceId: args.sequenceId }, recorder);
  if (!loadResult.success) {
    return handleLoadSequenceError(loadResult, 'get');
  }

  const sequence = loadResult.sequence;

  // Raw input events are only ever held in memory during recordInteraction -
  // a stored sequence keeps the converted commands, not the events. Say so
  // instead of silently returning the detail view.
  if (args.outputFormat === 'events') {
    return createErrorResponse('INVALID_PARAMETER', {
      parameter: 'outputFormat',
      value: 'events',
      message: 'A stored sequence holds commands, not raw input events. Use outputFormat: "commands" here, or outputFormat: "events" on action "recordInteraction" to dump the raw events of a live recording.'
    });
  }

  if (args.outputFormat === 'commands') {
    let output = `**${sequence.name} - Commands (JSON)**\n\n`;
    output += '```json\n';
    output += JSON.stringify(sequence.commands, null, 2);
    output += '\n```';
    return { content: [{ type: 'text', text: output }] };
  }

  // Check if output format is specified for code export
  if (args.outputFormat === 'playwright') {
    const code = generatePlaywrightCode(sequence.commands, sequence.startUrl);
    let output = `**${sequence.name} - Playwright Code**\n\n`;
    output += '```typescript\n';
    output += code;
    output += '\n```';
    return { content: [{ type: 'text', text: output }] };
  }

  if (args.outputFormat === 'puppeteer') {
    const code = generatePuppeteerCode(sequence.commands, sequence.startUrl);
    let output = `**${sequence.name} - Puppeteer Code**\n\n`;
    output += '```javascript\n';
    output += code;
    output += '\n```';
    return { content: [{ type: 'text', text: output }] };
  }

  return { content: [{ type: 'text', text: formatSequenceDetails(sequence) }] };
}

async function handleDelete(args: ReplayArgs, recorder: CommandRecorder) {
  // Use loadSequence to support both name and sequenceId
  const loadResult = await loadSequence({ name: args.name, sequenceId: args.sequenceId }, recorder);
  if (!loadResult.success) {
    return handleLoadSequenceError(loadResult, 'delete');
  }

  const sequence = loadResult.sequence;
  const deleted = recorder.deleteSequence(sequence.id);
  if (!deleted) {
    return createErrorResponse('SEQUENCE_NOT_FOUND', {
      sequenceId: sequence.id,
      message: `Sequence "${sequence.name}" not found.`
    });
  }

  return createSuccessResponse('SEQUENCE_DELETED', {
    sequenceId: sequence.id,
    name: sequence.name,
    message: `Sequence "${sequence.name}" deleted successfully.`
  });
}

async function handleExport(args: ReplayArgs, recorder: CommandRecorder) {
  const loadResult = await loadSequence({ name: args.name, sequenceId: args.sequenceId }, recorder);
  if (!loadResult.success) {
    return handleLoadSequenceError(loadResult, 'export');
  }

  const sequence = loadResult.sequence;
  const format = args.format || 'sequence';
  const overwrite = args.overwrite ?? false;

  // Always save sequence file first (for all formats)
  const sequenceResult = await recorder.saveSequenceToDisk(sequence.id, args.global ?? false, overwrite);
  if (!sequenceResult) {
    return createErrorResponse('EXPORT_FAILED', { message: 'Sequence not found.' });
  }
  if (!sequenceResult.success) {
    if (sequenceResult.conflict) {
      return createSuccessResponse('EXPORT_CONFLICT', {
        filepath: sequenceResult.filepath,
        sequenceName: sequence.name,
        format
      });
    }
    return createErrorResponse('EXPORT_FAILED', { message: sequenceResult.error });
  }

  // If only exporting sequence JSON, we're done
  if (format === 'sequence') {
    const location = args.global ? 'global (~/.cdp-tools/sequences/)' : 'working directory';
    return createSuccessResponse('EXPORT_SEQUENCE_SUCCESS', {
      filename: sequenceResult.filepath,
      location
    });
  }

  // Export as Playwright or Puppeteer test
  const replayConfig = configManager.getReplayConfig();
  const isPlaywright = format === 'playwright';
  const code = isPlaywright
    ? generatePlaywrightCode(sequence.commands, sequence.startUrl)
    : generatePuppeteerCode(sequence.commands, sequence.startUrl);
  const exportPath = isPlaywright ? replayConfig.playwrightExportPath : replayConfig.puppeteerExportPath;
  const extension = isPlaywright ? '.spec.ts' : '.test.js';

  const fs = await import('fs');
  const path = await import('path');
  const sanitizedName = sequence.name.replace(/[^a-zA-Z0-9-_]/g, '-');
  const fullPath = path.resolve(exportPath, `${sanitizedName}${extension}`);

  // Check for test file conflict
  if (fs.existsSync(fullPath) && !overwrite) {
    return createSuccessResponse('EXPORT_CONFLICT', {
      filepath: fullPath,
      sequenceName: sequence.name,
      format
    });
  }

  // Write the test file
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(fullPath, code, 'utf-8');

  return createSuccessResponse('EXPORT_SUCCESS', {
    testFile: fullPath,
    sequenceFile: sequenceResult.filepath,
    format
  });
}

async function handleLoad(args: ReplayArgs, recorder: CommandRecorder, getKnownToolNames?: () => string[]) {
  if (!args.filename) {
    return createErrorResponse('MISSING_PARAMETER', {
      action: 'load',
      missing: 'filename',
      message: 'The "load" action requires a "filename" parameter. Use listSaved to see available files.'
    });
  }

  // Reject unknown tool names up front rather than failing mid-run (bug-010).
  // Validation runs on the parsed candidate BEFORE it replaces any same-named
  // sequence in memory, so a bad file can't evict a good in-memory sequence.
  let invalid: ReturnType<typeof validateSequenceToolNames> = null;
  const sequence = await recorder.loadSequenceFromDisk(args.filename, {
    validate: (candidate) => {
      invalid = validateSequenceToolNames(candidate, 'load', getKnownToolNames);
      return invalid === null;
    },
  });

  if (invalid) return invalid;

  if (!sequence) {
    return createErrorResponse('LOAD_FAILED', {
      filename: args.filename,
      error: 'File may not exist or be invalid.'
    });
  }

  // If intoHistory is true, load commands into history without executing
  if (args.intoHistory) {
    let loadedCount = 0;
    for (const cmd of sequence.commands) {
      recorder.recordCommand(cmd.tool, cmd.params);
      loadedCount++;
    }

    return createSuccessResponse('SEQUENCE_LOADED_INTO_HISTORY', {
      sequenceId: sequence.id,
      name: sequence.name,
      commandCount: loadedCount,
      message: `Loaded ${loadedCount} commands from "${sequence.name}" into history. Use replay({ action: 'history' }) to view.`
    });
  }

  return createSuccessResponse('SEQUENCE_LOADED_FROM_DISK', {
    sequenceId: sequence.id,
    name: sequence.name,
    commandCount: sequence.commands.length,
    message: `Sequence "${sequence.name}" loaded successfully. Use replay({ action: 'run', sequenceId: '${sequence.id}' }) to execute.`
  });
}

async function handleListSaved(args: ReplayArgs, recorder: CommandRecorder) {
  const savedSequences = await recorder.listSavedSequencesOnDisk();
  const issueSequences = await recorder.listIssueSequencesOnDisk();
  const showAll = args.showAll ?? false;
  return { content: [{ type: 'text', text: formatSavedSequencesList(savedSequences, issueSequences, showAll) }] };
}

async function handleDeleteSaved(args: ReplayArgs, recorder: CommandRecorder) {
  if (!args.filename) {
    return createErrorResponse('MISSING_PARAMETER', {
      action: 'deleteSaved',
      missing: 'filename',
      message: 'The "deleteSaved" action requires a "filename" parameter'
    });
  }

  const deleted = await recorder.deleteSequenceFromDisk(args.filename);
  if (!deleted) {
    return createErrorResponse('DELETE_FAILED', {
      filename: args.filename,
      message: `Failed to delete file "${args.filename}". File may not exist.`
    });
  }

  return createSuccessResponse('SAVED_SEQUENCE_DELETED', {
    filename: args.filename,
    message: `Sequence file "${args.filename}" deleted successfully.`
  });
}

async function handleRun(
  args: ReplayArgs,
  recorder: CommandRecorder,
  executeToolCall: (toolName: string, params: Record<string, any>) => Promise<any>,
  getPageForConnection: (connectionReason: string) => Promise<any>,
  abortSignal?: AbortSignal,
  getConnectionPort?: (connectionReason: string) => Promise<number | null>
) {
  // Load sequence
  const loadResult = await loadSequence({ name: args.name, sequenceId: args.sequenceId }, recorder);
  if (!loadResult.success) {
    return handleLoadSequenceError(loadResult, 'run');
  }

  // Run-time retarget: baseUrl swaps the origin of every absolute URL in the
  // sequence (startUrl + command params); startUrl replaces the entry URL
  // wholesale. Lets one recorded sequence run against any deployment.
  const sequence = (args.baseUrl || args.startUrl)
    ? rebaseSequence(loadResult.sequence, { baseUrl: args.baseUrl, startUrl: args.startUrl })
    : loadResult.sequence;
  const commands = sequence.commands;
  const analysis = analyzeSequenceConnections(commands);

  // Determine connection reason
  let connectionReason = args.connectionReason || extractConnectionFromSequence(commands, analysis);

  // Validate connection requirement - fall back to a reason derived from the
  // sequence name so we can auto-launch Chrome instead of erroring out
  const needsConnection = sequenceNeedsConnection(commands);
  if (!connectionReason && !analysis.hasLaunchBeforeConnection && needsConnection) {
    connectionReason = deriveConnectionReference(sequence.name);
  }

  // Handle variable extraction and prompting
  const extractedVariables = extractTextVariables(commands);
  if (Object.keys(extractedVariables).length > 0 && args.variables === undefined) {
    const idParam = args.sequenceId || args.name!;
    return { content: [{ type: 'text', text: formatVariablePrompt(sequence.name, idParam, extractedVariables, connectionReason) }] };
  }

  // Build execution context
  const ctx: ExecutionContext = {
    executeToolCall,
    commandRecorder: recorder,
    connectionReason: connectionReason!,
    logPrefix: 'run',
    variableStore: {}
  };

  // Ensure connection is ready
  let didAutoLaunch = false;
  if (needsConnection && !analysis.hasLaunchBeforeConnection) {
    const connResult = await ensureConnection(ctx, needsConnection, analysis.hasLaunchBeforeConnection);
    if (!connResult.success) {
      return createErrorResponse('LAUNCH_FAILED', {
        message: connResult.error,
        suggestion: 'Launch Chrome manually first'
      });
    }
    didAutoLaunch = connResult.didAutoLaunch;
  }

  // Navigate to startUrl if needed
  const navResult = await navigateToStartUrl(ctx, sequence, analysis);
  if (!navResult.success) {
    // Close the tab if we auto-launched it
    if (didAutoLaunch && connectionReason) {
      await executeToolCall('tab', { action: 'close', reference: connectionReason }).catch(() => {});
    }
    return createErrorResponse('NAVIGATION_FAILED', {
      message: navResult.error,
      startUrl: sequence.startUrl
    });
  }

  // Inject cursor if enabled in config
  let cursorPage: any = null;
  if (configManager.getReplayConfig().showCursor && connectionReason) {
    cursorPage = await getPageForConnection(connectionReason);
    if (cursorPage) {
      await injectReplayCursor(cursorPage);
      setReplayCursorCallbacks({
        onClickBefore: async (x: number, y: number, isRightClick: boolean) => {
          await showClickEffect(cursorPage, x, y, isRightClick);
        },
        onKeyPress: async (key: string) => {
          await showKeyPress(cursorPage, key);
        }
      });
    }
  }

  // Show replay overlay if requested (for issue verification)
  let cleanupReplayOverlay: (() => Promise<void>) | undefined;
  if (args.showReplayOverlay && args.issueId && args.issueType && connectionReason) {
    const overlayPage = cursorPage || await getPageForConnection(connectionReason);
    if (overlayPage) {
      cleanupReplayOverlay = await showReplayOverlay(
        overlayPage,
        args.issueType,
        args.issueTitle || 'Verifying issue...',
        args.issueId
      );
    }
  }

  // Helper to clean up cursor, overlay, and optionally close tab
  const cleanup = async (closeTab = false) => {
    if (cursorPage) {
      await removeReplayCursor(cursorPage).catch(() => {});
      setReplayCursorCallbacks({});
    }
    if (cleanupReplayOverlay) {
      await cleanupReplayOverlay().catch(() => {});
    }
    if (closeTab && didAutoLaunch && connectionReason) {
      await executeToolCall('tab', { action: 'close', reference: connectionReason }).catch(() => {});
    }
  };

  // Calculate start step (convert 1-indexed to 0-indexed)
  const startStep = args.startFrom ? Math.max(0, args.startFrom - 1) : 0;

  // Validate startFrom
  if (args.startFrom && args.startFrom > sequence.commands.length) {
    await cleanup();
    return createErrorResponse('INVALID_START_FROM', {
      message: `startFrom (${args.startFrom}) exceeds sequence length (${sequence.commands.length})`
    });
  }

  // Register cleanup handler on abort signal BEFORE execution starts
  // This ensures cleanup runs even if the tool call is interrupted mid-execution
  if (abortSignal) {
    abortSignal.addEventListener('abort', () => { cleanup(true); }, { once: true });
  }

  // Execute the sequence
  const execResult = await executeSequenceWithPause({
    sequence,
    startStep,
    ctx,
    variables: args.variables,
    record: args.record,
    stepTimeout: args.stepTimeout,
    totalTimeout: args.totalTimeout,
    stepTo: args.stepTo,
    overrideConnectionReason: args.connectionReason,
    abortSignal
  });

  // Handle abort - return early (cleanup already handled by abort signal listener)
  if (abortSignal?.aborted) {
    const abortedResponse = createSuccessResponse('REPLAY_ABORTED', {
      name: sequence.name,
      completedSteps: execResult.results.length,
      totalSteps: sequence.commands.length,
      message: 'Replay aborted by user'
    });
    abortedResponse._meta = {
      tool: 'replay', action: 'run', timestamp: Date.now(),
      replay: { success: false, totalSteps: sequence.commands.length, failedSteps: execResult.results.filter(r => !r.success).length, paused: true }
    };
    return abortedResponse;
  }

  // Handle breakpoint hit
  if (execResult.breakpointHit && connectionReason) {
    return { content: [{ type: 'text', text: formatBreakpointHit(
      sequence.name,
      execResult.results,
      execResult.totalCommands,
      execResult.durationMs,
      execResult.breakpointHit,
      connectionReason
    ) }],
      _meta: {
        tool: 'replay', action: 'run', timestamp: Date.now(),
        replay: { success: false, totalSteps: sequence.commands.length, failedSteps: execResult.results.filter(r => !r.success).length, paused: true }
      }
    };
  }

  // Handle click validation failure (pause for inspection/retry)
  if (execResult.clickValidationFailure && connectionReason) {
    // Set active sequence state so user can retry/continue
    const activeState: ActiveSequenceState = {
      sequenceId: sequence.id,
      sequenceName: sequence.name,
      currentStep: execResult.pausedAtStep! - 1, // Back to failed step for retry
      totalSteps: sequence.commands.length,
      pausedAt: Date.now(),
      historyIndexAtPause: recorder.getHistory().length,
      connectionReason,
    };
    recorder.setActiveSequence(activeState);

    return { content: [{ type: 'text', text: formatClickValidationFailure(
      sequence,
      execResult.results,
      execResult.pausedAtStep!,
      execResult.durationMs,
      execResult.clickValidationFailure,
      connectionReason
    ) }],
      _meta: {
        tool: 'replay', action: 'run', timestamp: Date.now(),
        replay: { success: false, totalSteps: sequence.commands.length, failedSteps: execResult.results.filter(r => !r.success).length, paused: true }
      }
    };
  }

  // Handle paused state (stepTo)
  if (execResult.pausedAtStep && execResult.activeSequenceState) {
    recorder.setActiveSequence(execResult.activeSequenceState);
    return { content: [{ type: 'text', text: formatPausedResponse(sequence, execResult.results, execResult.pausedAtStep, execResult.durationMs) }],
      _meta: {
        tool: 'replay', action: 'run', timestamp: Date.now(),
        replay: { success: false, totalSteps: sequence.commands.length, failedSteps: execResult.results.filter(r => !r.success).length, paused: true }
      }
    };
  }

  // Clean up cursor and overlay
  await cleanup();

  // Format results
  let response = formatExecutionResults(sequence.name, execResult.results, execResult.totalCommands, execResult.durationMs);

  // Add debug state if successful
  const failed = execResult.results.filter(r => !r.success).length;
  if (connectionReason && failed === 0) {
    const debugState = await getDebugState(ctx);
    if (debugState) {
      response += formatDebugState(debugState, connectionReason);
    }
  }

  // Kill the Chrome used by this run's own connection, if requested.
  //
  // Deliberately run-level ONLY. A multi-device sequence can touch several browsers
  // (steps may carry their own connectionReason), but a per-step connection is
  // usually one the run did NOT launch: a long-lived instance the user started by
  // hand and expects to keep. Nothing here tracks which connections the run itself
  // caused to be launched - `didAutoLaunch` covers the run-level connection only,
  // and a `launchChrome` step silently reuses an existing connection with the same
  // reference (CHROME_CONNECTION_REUSED), so its presence in the sequence proves
  // nothing about ownership. Rather than guess, we under-kill: a leaked browser is
  // visible and closable, a killed one takes state the user cannot get back.
  if (args.killChromeOnFinish && connectionReason && getConnectionPort) {
    const port = await getConnectionPort(connectionReason);
    if (port !== null) {
      const killResult = await executeToolCall('killChrome', {
        reason: `killChromeOnFinish: sequence "${sequence.name}" completed`,
        port,
      }).catch((error: any) => ({ isError: true, error }));
      response += killResult?.isError
        ? `\n\n**Chrome kill failed** (${connectionReason}, port ${port}, killChromeOnFinish)`
        : `\n\n**Chrome killed** (${connectionReason}, port ${port}, killChromeOnFinish)`;
    }
  }

  return { content: [{ type: 'text', text: response }],
    _meta: {
      tool: 'replay', action: 'run', timestamp: Date.now(),
      replay: { success: failed === 0, totalSteps: execResult.totalCommands, failedSteps: failed, paused: false }
    }
  };
}

async function handleStatus(recorder: CommandRecorder) {
  const activeSeq = recorder.getActiveSequence();
  if (!activeSeq) {
    return { content: [{ type: 'text', text: '**No active sequence.** Use `replay({ action: \'run\', name: \'...\', stepTo: N })` to start a step-through session.' }] };
  }

  const commandsSincePause = recorder.getCommandsSincePause();
  return { content: [{ type: 'text', text: formatActiveStatus(activeSeq, commandsSincePause) }] };
}

async function handleCancel(recorder: CommandRecorder) {
  const activeSeq = recorder.getActiveSequence();
  if (!activeSeq) {
    return { content: [{ type: 'text', text: '**No active sequence to cancel.**' }] };
  }

  const name = activeSeq.sequenceName;
  recorder.setActiveSequence(null);
  return { content: [{ type: 'text', text: `**Cancelled:** ${name}` }] };
}

async function handleStep(
  args: ReplayArgs,
  recorder: CommandRecorder,
  executeToolCall: (toolName: string, params: Record<string, any>) => Promise<any>
) {
  const activeSeq = recorder.getActiveSequence();
  if (!activeSeq) {
    return createErrorResponse('NO_ACTIVE_SEQUENCE', {
      message: 'No active sequence to step through. Use run with stepTo first.'
    });
  }

  const sequence = recorder.getSequence(activeSeq.sequenceId);
  if (!sequence) {
    recorder.setActiveSequence(null);
    return createErrorResponse('SEQUENCE_NOT_FOUND', {
      message: `Sequence ${activeSeq.sequenceId} no longer exists`
    });
  }

  const commands = sequence.commands;
  const stepCount = args.stepCount || 1;
  const startStep = activeSeq.currentStep;
  const endStep = Math.min(startStep + stepCount, commands.length);

  if (startStep >= commands.length) {
    recorder.setActiveSequence(null);
    return { content: [{ type: 'text', text: `**Sequence complete.** All ${commands.length} steps executed.` }] };
  }

  const ctx: ExecutionContext = {
    executeToolCall,
    commandRecorder: recorder,
    connectionReason: activeSeq.connectionReason,
    logPrefix: 'step',
    variableStore: activeSeq.capturedVariables ?? (activeSeq.capturedVariables = {}),
    runTimestamp: activeSeq.runTimestamp ?? (activeSeq.runTimestamp = Date.now())
  };

  const execResult = await executeSteps({
    sequence,
    startStep,
    endStep,
    ctx
  });

  const lastExecuted = execResult.results.length > 0 ? execResult.results[execResult.results.length - 1].step : startStep;
  const failed = execResult.results.some(r => !r.success);

  // Update active sequence state
  if (failed || lastExecuted >= commands.length) {
    recorder.setActiveSequence(null);
  } else {
    recorder.updateActiveSequenceStep(lastExecuted);
  }

  return { content: [{ type: 'text', text: formatStepResults(sequence.name, execResult.results, startStep, commands.length, failed) }] };
}

async function handleFinish(
  recorder: CommandRecorder,
  executeToolCall: (toolName: string, params: Record<string, any>) => Promise<any>
) {
  const activeSeq = recorder.getActiveSequence();
  if (!activeSeq) {
    return createErrorResponse('NO_ACTIVE_SEQUENCE', {
      message: 'No active sequence to finish. Use run with stepTo first.'
    });
  }

  const sequence = recorder.getSequence(activeSeq.sequenceId);
  if (!sequence) {
    recorder.setActiveSequence(null);
    return createErrorResponse('SEQUENCE_NOT_FOUND', {
      message: `Sequence ${activeSeq.sequenceId} no longer exists`
    });
  }

  const commands = sequence.commands;
  const startStep = activeSeq.currentStep;

  if (startStep >= commands.length) {
    recorder.setActiveSequence(null);
    return { content: [{ type: 'text', text: `**Sequence already complete.** All ${commands.length} steps executed.` }] };
  }

  const ctx: ExecutionContext = {
    executeToolCall,
    commandRecorder: recorder,
    connectionReason: activeSeq.connectionReason,
    logPrefix: 'finish',
    variableStore: activeSeq.capturedVariables ?? (activeSeq.capturedVariables = {}),
    runTimestamp: activeSeq.runTimestamp ?? (activeSeq.runTimestamp = Date.now())
  };

  const execResult = await executeSteps({
    sequence,
    startStep,
    ctx
  });

  // Clear active sequence
  recorder.setActiveSequence(null);

  return { content: [{ type: 'text', text: formatExecutionResults(sequence.name, execResult.results, commands.length, execResult.durationMs) }] };
}

async function handleInsert(args: ReplayArgs, recorder: CommandRecorder) {
  const activeSeq = recorder.getActiveSequence();
  if (!activeSeq) {
    return createErrorResponse('NO_ACTIVE_SEQUENCE', {
      message: 'No active sequence. Use run with stepTo first to pause a sequence.'
    });
  }

  const sequence = recorder.getSequence(activeSeq.sequenceId);
  if (!sequence) {
    return createErrorResponse('SEQUENCE_NOT_FOUND', {
      message: `Sequence ${activeSeq.sequenceId} no longer exists`
    });
  }

  const commandsSincePause = recorder.getCommandsSincePause();

  // If no insertIndices provided, show available commands
  if (!args.insertIndices || args.insertIndices.length === 0) {
    return { content: [{ type: 'text', text: formatInsertPrompt(sequence.name, commandsSincePause, activeSeq.currentStep, activeSeq.totalSteps) }] };
  }

  // Check if history was viewed first (required before insert with indices)
  if (!recorder.wasHistoryViewed()) {
    return {
      content: [{
        type: 'text',
        text: '**Run `replay({ action: \'history\' })` first** to see available commands and their indices before inserting.'
      }],
      isError: true
    };
  }

  // Validate indices
  const validIndices = args.insertIndices.filter(idx =>
    commandsSincePause.some(cmd => cmd.index === idx)
  );

  if (validIndices.length === 0) {
    let errorMsg = 'None of the provided indices are valid commands recorded since pause.\n\n';
    errorMsg += '**Run `replay({ action: \'history\' })` again** to see available commands and their indices.\n\n';
    if (commandsSincePause.length > 0) {
      errorMsg += `Valid indices since pause: ${commandsSincePause.map(c => c.index).join(', ')}`;
    } else {
      errorMsg += 'No commands have been recorded since the sequence was paused.';
    }
    return { content: [{ type: 'text', text: errorMsg }], isError: true };
  }

  // Get commands to insert
  const commandsToInsert = validIndices
    .map(idx => commandsSincePause.find(cmd => cmd.index === idx))
    .filter((cmd): cmd is NonNullable<typeof cmd> => cmd !== undefined)
    .map(cmd => ({ tool: cmd.tool, params: cmd.params }));

  // Determine insert position
  const insertAfter = args.insertAfterStep !== undefined ? args.insertAfterStep : activeSeq.currentStep;

  // Build new commands array
  const newCommands = [
    ...sequence.commands.slice(0, insertAfter),
    ...commandsToInsert,
    ...sequence.commands.slice(insertAfter)
  ];

  if (args.overwrite) {
    // Update existing sequence in place
    (sequence as any).commands = newCommands;

    return { content: [{ type: 'text', text: formatInsertResult(sequence.name, sequence.id, commandsToInsert.length, insertAfter, newCommands.length, true) }] };
  } else {
    // Create new sequence
    const newName = args.newName || `${sequence.name}-modified`;
    const newSequence = await recorder.createSequence(
      newName,
      [],
      { description: sequence.description, expectedOutcome: sequence.expectedOutcome, startUrl: sequence.startUrl }
    );

    if (!newSequence) {
      return createErrorResponse('CREATE_FAILED', { message: 'Failed to create new sequence' });
    }

    // Manually set commands
    (newSequence as any).commands = newCommands;

    return { content: [{ type: 'text', text: formatInsertResult(newName, newSequence.id, commandsToInsert.length, insertAfter, newCommands.length, false) }] };
  }
}

// =============================================================================
// Interaction Recording Handlers
// =============================================================================

async function handleRecordInteraction(
  args: ReplayArgs,
  executeToolCall: (toolName: string, params: Record<string, any>) => Promise<any>,
  getPageForConnection?: (connectionReason: string) => Promise<any>,
  recorder?: CommandRecorder,
  abortSignal?: AbortSignal
) {
  if (!args.connectionReason) {
    return createErrorResponse('MISSING_PARAMETER', {
      action: 'recordInteraction',
      missing: 'connectionReason',
      message: 'The "recordInteraction" action requires a "connectionReason" to identify the browser tab'
    });
  }

  if (!getPageForConnection) {
    return createErrorResponse('NOT_SUPPORTED', {
      message: 'Interaction recording is not supported in this context'
    });
  }

  // If issueId is provided, look up the issue and use its details
  let issueId = args.issueId;
  let issueType = args.issueType;
  let issueTitle = args.issueTitle;
  let startUrl = args.startUrl;

  if (issueId) {
    const issue = await getIssue(issueId);
    if (!issue) {
      return createErrorResponse('ISSUES_NOT_FOUND', {
        id: issueId,
        message: `Issue #${issueId} not found`
      });
    }
    // Use issue details (override any provided args)
    issueType = issue.type;
    issueTitle = issue.title;
    startUrl = startUrl || issue.startUrl;  // Use provided startUrl or fall back to issue's startUrl
  }

  let page = await getPageForConnection(args.connectionReason);

  // Auto-launch Chrome if no connection found (requires startUrl)
  if (!page) {
    if (!startUrl) {
      return createErrorResponse('MISSING_PARAMETER', {
        action: 'recordInteraction',
        missing: 'startUrl',
        message: 'Chrome is not running. Provide a "startUrl" or "issueId" (with startUrl) to auto-launch Chrome and navigate before recording.'
      });
    }

    const launchResult = await autoLaunchChrome(executeToolCall, args.connectionReason, 'recordInteraction');
    if (!launchResult.success) {
      return createErrorResponse(launchResult.errorType, {
        reference: args.connectionReason,
        error: launchResult.error
      });
    }

    // Navigate to the startUrl
    const navResult = await executeToolCall('navigate', {
      action: 'goto',
      connectionReason: args.connectionReason,
      url: startUrl
    });
    if (navResult?.isError) {
      return createErrorResponse('NAVIGATION_FAILED', {
        url: startUrl,
        message: `Failed to navigate to startUrl: ${navResult?.content?.[0]?.text || 'Unknown error'}`
      });
    }

    // Try getting the page again after launch
    page = await getPageForConnection(args.connectionReason);
    if (!page) {
      return createErrorResponse('CONNECTION_NOT_FOUND', {
        connectionReason: args.connectionReason,
        message: 'Failed to connect to Chrome after auto-launch'
      });
    }
  } else if (startUrl) {
    // Page already exists but startUrl provided - navigate to it
    const navResult = await executeToolCall('navigate', {
      action: 'goto',
      connectionReason: args.connectionReason,
      url: startUrl
    });
    if (navResult?.isError) {
      return createErrorResponse('NAVIGATION_FAILED', {
        url: startUrl,
        message: `Failed to navigate to startUrl: ${navResult?.content?.[0]?.text || 'Unknown error'}`
      });
    }
  }

  const showOverlay = args.showOverlay !== false;
  const sequenceName = args.name || (issueId ? `${issueType}-${issueId}-repro` : args.connectionReason);

  // startRecording now blocks until recording completes
  // If issueId is provided, startRecording will show a fullscreen overlay with issue details
  const result = await startRecording(page, args.connectionReason, {
    showOverlay,
    abortSignal,
    issueId
  });

  // Close the tab if requested by the recording result
  if (result.closeTab) {
    try {
      await executeToolCall('tab', {
        action: 'close',
        reference: args.connectionReason,
      });
    } catch {
      // Non-fatal - tab may already be closed
    }
  }

  if (!result.success) {
    if (result.cancelled) {
      return {
        content: [{
          type: 'text',
          text: '**Recording cancelled** - no sequence created.'
        }]
      };
    }
    return createErrorResponse('RECORDING_FAILED', { message: result.error });
  }

  // Recording completed - create the sequence
  const recording = result.recording!;
  const summary = recording.summary;

  const replayConfig = configManager.getReplayConfig();
  // Recording options come from args; the defaults are the values that used to
  // be hardcoded here, so omitting them keeps the previous behaviour.
  // preferSelectors wins over preferCoordinates when both are set.
  const commands = eventsToCommands(recording.events, {
    simplify: args.simplifyEvents ?? true,
    includeDelays: true,
    includeHovers: args.includeHovers ?? false,
    preferCoordinates: args.preferCoordinates ?? false,
    preferSelectors: args.preferSelectors ?? false,
    maxDelayMs: replayConfig.maxDelayMs,
  });

  // Generate condensed timeline
  const timeline = generateCondensedTimeline(recording.events);

  // Check for BUG and FEATURE comments
  const bugComments = recording.events
    .filter((e): e is CommentEvent => isCommentEvent(e) && e.category === 'bug');
  const featureComments = recording.events
    .filter((e): e is CommentEvent => isCommentEvent(e) && e.category === 'feature');

  const hasIssues = bugComments.length > 0 || featureComments.length > 0;

  // Build sequence data for saving
  const sequenceData: CommandSequence = {
    id: `seq-${Date.now()}`,
    name: sequenceName,
    commands,
    createdAt: Date.now(),
    startUrl: recording.startUrl,
    description: `Recorded from ${args.connectionReason}`,
  };

  // Only create in-memory sequence if no issues (issues go to issues folder only)
  let sequence: CommandSequence | null = null;
  if (!hasIssues && recorder) {
    // Delete existing sequence if overwriting
    if (args.overwrite && recorder.sequenceNameExists(sequenceName)) {
      const existingSeq = recorder.listSequences().find(s => s.name === sequenceName);
      if (existingSeq) {
        recorder.deleteSequence(existingSeq.id);
      }
    }

    // Check for name conflict
    if (recorder.sequenceNameExists(sequenceName) && !args.overwrite) {
      return createSuccessResponse('RECORDING_NAME_CONFLICT', {
        sequenceName,
        connectionReason: args.connectionReason
      });
    }

    sequence = await recorder.createSequenceFromCommands(sequenceName, commands, {
      startUrl: recording.startUrl,
      description: `Recorded from ${args.connectionReason}`,
    });
  }

  const createdIssues: Array<{ id: number; type: string; title: string }> = [];

  // Initialize issue tracker
  await initializeTracker();

  // Create issues and save sequences for each bug/feature comment
  // Each issue gets its own sequence with a unique ID
  for (const comment of [...bugComments, ...featureComments]) {
    const issueType = comment.category as 'bug' | 'feature';

    // Create the issue first (with temp filename, will be updated by saveIssueSequence)
    const issue = await addIssue({
      type: issueType,
      title: comment.text,
      sequenceFile: '',
      recordingName: sequenceName,
      initialStatus: 'pending',
      startUrl: recording.startUrl || '',
    });

    // Create a unique sequence for this issue (each issue gets its own copy)
    const issueSequenceData: CommandSequence = {
      ...sequenceData,
      id: `seq-${Date.now()}-${issue.id}`,
      name: `${issueType}-${issue.id}-repro`,
    };

    // Save sequence and link to issue
    await saveIssueSequence(issue.id, issueType, comment.text, issueSequenceData);

    createdIssues.push({
      id: issue.id,
      type: issueType,
      title: comment.text,
    });
  }

  // If issueId provided, save sequence to issues folder and link to existing issue
  if (issueId && issueType && issueTitle) {
    await saveIssueSequence(
      issueId,
      issueType,
      issueTitle,
      sequenceData,
      `CDP Tools verification sequence for ${issueType} #${issueId}: ${issueTitle}`
    );
  }

  const response = createSuccessResponse('RECORDING_STOPPED', {
    name: sequence?.name || sequenceData.name,
    sequenceId: sequence?.id || sequenceData.id,
    duration: (recording.duration / 1000).toFixed(1),
    startUrl: recording.startUrl,
    commandCount: commands.length,
    clicks: summary.clicks,
    drags: summary.drags,
    scrolls: summary.scrolls,
    keyPresses: summary.keyPresses,
    navigations: summary.navigations > 0 ? summary.navigations : null,
    comments: summary.comments > 0 ? summary.comments : null,
    timeline: timeline || null,
    bugCount: bugComments.length > 0 ? bugComments.length : null,
    featureCount: featureComments.length > 0 ? featureComments.length : null,
    hasIssues: createdIssues.length > 0,
    issuesCreatedList: createdIssues.length > 0
      ? createdIssues.map(i => `#${i.id} (${i.type})`).join(', ')
      : null,
  });

  // outputFormat dumps the underlying data alongside the summary. The raw
  // events only exist here - a saved sequence keeps commands, not events.
  if (args.outputFormat === 'events') {
    response.content[0].text += `\n\n**Raw recorded events (${recording.events.length})**\n\n\`\`\`json\n${JSON.stringify(recording.events, null, 2)}\n\`\`\``;
  } else if (args.outputFormat === 'commands') {
    response.content[0].text += `\n\n**Commands (JSON)**\n\n\`\`\`json\n${JSON.stringify(commands, null, 2)}\n\`\`\``;
  } else if (args.outputFormat === 'playwright') {
    response.content[0].text += `\n\n**Playwright Code**\n\n\`\`\`typescript\n${generatePlaywrightCode(commands, recording.startUrl)}\n\`\`\``;
  } else if (args.outputFormat === 'puppeteer') {
    response.content[0].text += `\n\n**Puppeteer Code**\n\n\`\`\`javascript\n${generatePuppeteerCode(commands, recording.startUrl)}\n\`\`\``;
  }

  return response;
}


/**
 * Escape a string for use in JavaScript code generation
 * Handles newlines, quotes, backslashes, and other special characters
 */
function escapeJsString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')   // Backslashes first
    .replace(/'/g, "\\'")      // Single quotes
    .replace(/\n/g, '\\n')     // Newlines
    .replace(/\r/g, '\\r')     // Carriage returns
    .replace(/\t/g, '\\t');    // Tabs
}

/**
 * Generate Puppeteer test code from sequence commands
 */
function generatePuppeteerCode(commands: Array<{ tool: string; params: Record<string, any> }>, startUrl?: string): string {
  const lines: string[] = [
    '// Generated from cdp-tools interaction recording',
    'const puppeteer = require(\'puppeteer\');',
    '',
    'async function runTest() {',
    '  const browser = await puppeteer.launch({ headless: false });',
    '  const page = await browser.newPage();',
    '',
  ];

  if (startUrl) {
    lines.push(`  await page.goto('${startUrl}');`);
    lines.push('');
  }

  for (const cmd of commands) {
    if (cmd.tool === 'navigate') {
      const { action, ...params } = cmd.params;
      if (action === 'goto' && params.url) {
        lines.push(`  await page.goto('${params.url}');`);
        lines.push('');
      } else if (action === 'reload') {
        lines.push(`  await page.reload();`);
        lines.push('');
      }
    } else if (cmd.tool === 'input') {
      const { action, ...params } = cmd.params;

      switch (action) {
        case 'drag':
          lines.push(`  // Drag from (${params.from.x}, ${params.from.y}) to (${params.to.x}, ${params.to.y})`);
          lines.push(`  await page.mouse.move(${params.from.x}, ${params.from.y});`);
          lines.push(`  await page.mouse.down();`);
          lines.push(`  await page.mouse.move(${params.to.x}, ${params.to.y});`);
          lines.push(`  await page.mouse.up();`);
          lines.push('');
          break;

        case 'scroll':
          lines.push(`  // Scroll at (${params.x}, ${params.y})`);
          if (params.x !== undefined && params.y !== undefined) {
            lines.push(`  await page.mouse.move(${params.x}, ${params.y});`);
          }
          lines.push(`  await page.mouse.wheel({ deltaX: ${params.deltaX || 0}, deltaY: ${params.deltaY || 0} });`);
          lines.push('');
          break;

        case 'mousemove':
          lines.push(`  await page.mouse.move(${params.x}, ${params.y});`);
          break;

        case 'click':
          if (typeof params.x === 'number' && typeof params.y === 'number') {
            lines.push(`  await page.mouse.click(${params.x}, ${params.y});`);
          } else if (params.selector) {
            lines.push(`  await page.click('${params.selector}');`);
          }
          lines.push('');
          break;

        case 'type':
          lines.push(`  await page.keyboard.type('${escapeJsString(params.text)}');`);
          lines.push('');
          break;

        case 'press':
          lines.push(`  await page.keyboard.press('${escapeJsString(params.key)}');`);
          lines.push('');
          break;
      }
    }
  }

  lines.push('  await browser.close();');
  lines.push('}');
  lines.push('');
  lines.push('runTest().catch(console.error);');

  return lines.join('\n');
}

function generatePlaywrightCode(commands: Array<{ tool: string; params: Record<string, any>; delay?: number; comment?: string }>, startUrl?: string): string {
  const lines: string[] = [
    '// Generated from cdp-tools interaction recording',
    "import { test, expect } from '@playwright/test';",
    '',
    "test('recorded interaction', async ({ page }) => {",
  ];

  if (startUrl) {
    lines.push(`  await page.goto('${startUrl}');`);
    lines.push('');
  }

  for (const cmd of commands) {
    // Add comment if present
    if (cmd.comment) {
      lines.push(`  // ${cmd.comment}`);
    }

    // Add delay if present
    if (cmd.delay && cmd.delay > 100) {
      lines.push(`  await page.waitForTimeout(${cmd.delay});`);
    }

    if (cmd.tool === 'navigate') {
      const { action, ...params } = cmd.params;
      if (action === 'goto' && params.url) {
        lines.push(`  await page.goto('${params.url}');`);
        lines.push('');
      } else if (action === 'reload') {
        lines.push(`  await page.reload();`);
        lines.push('');
      } else if (action === 'back') {
        lines.push(`  await page.goBack();`);
        lines.push('');
      } else if (action === 'forward') {
        lines.push(`  await page.goForward();`);
        lines.push('');
      }
    } else if (cmd.tool === 'input') {
      const { action, ...params } = cmd.params;

      switch (action) {
        case 'drag':
          lines.push(`  // Drag from (${params.from.x}, ${params.from.y}) to (${params.to.x}, ${params.to.y})`);
          lines.push(`  await page.mouse.move(${params.from.x}, ${params.from.y});`);
          lines.push(`  await page.mouse.down();`);
          lines.push(`  await page.mouse.move(${params.to.x}, ${params.to.y});`);
          lines.push(`  await page.mouse.up();`);
          lines.push('');
          break;

        case 'scroll':
          lines.push(`  // Scroll at (${params.x || 0}, ${params.y || 0})`);
          if (params.x !== undefined && params.y !== undefined) {
            lines.push(`  await page.mouse.move(${params.x}, ${params.y});`);
          }
          lines.push(`  await page.mouse.wheel(${params.deltaX || 0}, ${params.deltaY || 0});`);
          lines.push('');
          break;

        case 'mousemove':
          lines.push(`  await page.mouse.move(${params.x}, ${params.y});`);
          break;

        case 'click':
          if (typeof params.x === 'number' && typeof params.y === 'number') {
            lines.push(`  await page.mouse.click(${params.x}, ${params.y});`);
          } else if (params.selector) {
            lines.push(`  await page.click('${params.selector}');`);
          }
          lines.push('');
          break;

        case 'type':
          // Playwright uses type() for key-by-key typing, fill() for setting value directly
          lines.push(`  await page.keyboard.type('${escapeJsString(params.text)}');`);
          lines.push('');
          break;

        case 'press':
          lines.push(`  await page.keyboard.press('${escapeJsString(params.key)}');`);
          lines.push('');
          break;

        case 'hover':
          if (params.selector) {
            lines.push(`  await page.hover('${params.selector}');`);
          }
          lines.push('');
          break;
      }
    }
  }

  lines.push('});');

  return lines.join('\n');
}

// =============================================================================
// Tool Export
// =============================================================================

export function createReplayTools(
  commandRecorder: CommandRecorder,
  executeToolCall: (toolName: string, params: Record<string, any>) => Promise<any>,
  getPageForConnection?: (connectionReason: string) => Promise<any>,
  getConnectionPort?: (connectionReason: string) => Promise<number | null>,
  /**
   * Lazy provider for the set of registered tool names, used to reject sequence
   * steps naming a nonexistent tool at create/load time (bug-010). Lazy because
   * the tool map is built after this factory runs. When omitted, tool names are
   * not validated (previous behaviour).
   */
  getKnownToolNames?: () => string[]
) {
  return {
    replay: createTool(
      'Record and replay command sequences for testing and automation. Actions: repeat (immediately re-execute commands by history index - use this to repeat recent actions), history (view command history), recordInteraction (record real mouse/keyboard/navigation via a browser overlay - BLOCKS until the person finishes, so do not call it unattended; tune the capture with simplifyEvents/includeHovers/preferCoordinates/preferSelectors, and add outputFormat: events|commands|playwright|puppeteer to dump the recording), create (create sequence from history indices), list (list in-memory sequences), get (get sequence details; outputFormat: commands|playwright|puppeteer returns the raw command JSON or generated test code), delete (delete from memory), export (write a sequence to disk as sequence/playwright/puppeteer), load (load sequence from disk), listSaved (list saved files), deleteSaved (delete saved file), run (load and execute a sequence), runFromLog (execute commands from log lines), step (execute next N commands in a paused sequence), finish (complete remaining commands), insert (insert recorded commands into a sequence), status (show active sequence status), cancel (abort the active sequence)',
      replaySchema,
      async (args, abortSignal) => {
        switch (args.action) {
          case 'history':
            return handleHistory(args, commandRecorder);
          case 'create':
            return handleCreate(args, commandRecorder, getKnownToolNames);
          case 'list':
            return handleList(commandRecorder);
          case 'get':
            return handleGet(args, commandRecorder);
          case 'delete':
            return handleDelete(args, commandRecorder);
          case 'export':
            return handleExport(args, commandRecorder);
          case 'load':
            return handleLoad(args, commandRecorder, getKnownToolNames);
          case 'listSaved':
            return handleListSaved(args, commandRecorder);
          case 'deleteSaved':
            return handleDeleteSaved(args, commandRecorder);
          case 'run':
            return handleRun(args, commandRecorder, executeToolCall, getPageForConnection!, abortSignal, getConnectionPort);
          case 'status':
            return handleStatus(commandRecorder);
          case 'step':
            return handleStep(args, commandRecorder, executeToolCall);
          case 'finish':
            return handleFinish(commandRecorder, executeToolCall);
          case 'insert':
            return handleInsert(args, commandRecorder);
          case 'cancel':
            return handleCancel(commandRecorder);
          case 'repeat':
            return handleRepeat(args, commandRecorder, executeToolCall);
          case 'runFromLog':
            return handleRunFromLog(args, executeToolCall);
          case 'recordInteraction':
            return handleRecordInteraction(args, executeToolCall, getPageForConnection, commandRecorder, abortSignal);
          default:
            return createErrorResponse('INVALID_ACTION', { action: args.action });
        }
      }
    ),
  };
}
