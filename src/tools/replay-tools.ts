/**
 * Command Replay Tools - Action router for sequence recording and playback
 */

import { z } from 'zod';
import type { CommandRecorder, ActiveSequenceState, CommandSequence } from '../command-recorder.js';
import { createTool } from '../validation-helpers.js';
import { createSuccessResponse, createErrorResponse } from '../messages.js';

import {
  loadSequence,
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
  TOOLS_NEEDING_CONNECTION,
  type ExecutionContext,
} from './replay-executor.js';

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
  stopRecording,
  getRecording,
  listRecordings,
  clearRecording,
  clearAllRecordings,
  getRecordingStatus,
  simplifyEvents,
  eventsToCommands,
  formatEventsForReview,
  formatEventsAsCSV,
  type CommandConversionOptions,
} from '../interaction-recorder.js';

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
    'startMouseRecording', 'stopMouseRecording', 'mouseRecordingStatus',
    'recordInteraction', 'stopInteraction', 'listInteractions', 'getInteraction', 'clearInteraction', 'replayInteraction'
  ]).describe(
    'history,create,list,get,delete,export,load,listSaved,deleteSaved,run,step,finish,insert,status,cancel,repeat,runFromLog,recordInteraction,stopInteraction,listInteractions,getInteraction,clearInteraction,replayInteraction'
  ),
  limit: z.number().optional().describe('Max commands to show (history, default:50)'),
  name: z.string().optional().describe('Sequence name'),
  description: z.string().optional().describe('Sequence description'),
  expectedOutcome: z.string().optional().describe('Expected result'),
  startUrl: z.string().optional().describe('Starting URL (auto-extracted if not set)'),
  indices: z.array(z.number()).optional().describe('Command indices (create)'),
  lines: z.array(z.number()).optional().describe('History.log line numbers (runFromLog)'),
  sequenceId: z.string().optional().describe('Sequence ID'),
  global: z.boolean().optional().describe('Save to ~/.cdp-tools/ (default:false)'),
  format: z.enum(['sequence', 'playwright', 'puppeteer']).optional().describe('Export format (default:sequence)'),
  filename: z.string().optional().describe('Filename (load/deleteSaved)'),
  intoHistory: z.boolean().optional().describe('Load into history only (default:false)'),
  connectionReason: z.string().optional().describe('Browser connection reference'),
  record: z.boolean().optional().describe('Record commands during run (default:false)'),
  variables: z.record(z.string()).optional().describe('Variable substitutions {key:value}'),
  stepTimeout: z.number().optional().describe('Per-step timeout ms (default:30000)'),
  totalTimeout: z.number().optional().describe('Total timeout ms (default:300000)'),
  startFrom: z.number().optional().describe('Start from step N (1-indexed)'),
  stepTo: z.number().optional().describe('Pause after step N'),
  stepCount: z.number().optional().describe('Commands to execute (step, default:1)'),
  insertIndices: z.array(z.number()).optional().describe('History indices to insert'),
  insertAfterStep: z.number().optional().describe('Insert after step N'),
  overwrite: z.boolean().optional().describe('Overwrite existing (default:false)'),
  newName: z.string().optional().describe('New name when not overwriting'),
  showOverlay: z.boolean().optional().describe('Show recording overlay (default:true)'),
  simplifyEvents: z.boolean().optional().describe('Remove redundant movements (default:true)'),
  includeHovers: z.boolean().optional().describe('Include mousemove (default:false)'),
  outputFormat: z.enum(['events', 'commands', 'puppeteer', 'playwright', 'review', 'csv']).optional().describe('Output format'),
  preferCoordinates: z.boolean().optional().describe('Use x,y for clicks (canvas/3D)'),
  preferSelectors: z.boolean().optional().describe('Use selectors for clicks (DOM)'),
  recordingId: z.number().optional().describe('Recording ID'),
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

async function handleCreate(args: ReplayArgs, recorder: CommandRecorder) {
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

  const sequence = await recorder.createSequence(args.name, args.indices, {
    description: args.description,
    expectedOutcome: args.expectedOutcome,
    startUrl: args.startUrl,
  });

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
    return createErrorResponse(loadResult.errorCode, { message: loadResult.error });
  }

  const sequence = loadResult.sequence;

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
  if (!args.sequenceId) {
    return createErrorResponse('MISSING_PARAMETER', {
      action: 'delete',
      missing: 'sequenceId',
      message: 'The "delete" action requires a "sequenceId" parameter'
    });
  }

  const deleted = recorder.deleteSequence(args.sequenceId);
  if (!deleted) {
    return createErrorResponse('SEQUENCE_NOT_FOUND', {
      sequenceId: args.sequenceId,
      message: `Sequence "${args.sequenceId}" not found.`
    });
  }

  return createSuccessResponse('SEQUENCE_DELETED', {
    sequenceId: args.sequenceId,
    message: 'Sequence deleted successfully.'
  });
}

async function handleExport(args: ReplayArgs, recorder: CommandRecorder) {
  if (!args.sequenceId && !args.name) {
    return createErrorResponse('MISSING_PARAMETER', {
      action: 'export',
      missing: 'sequenceId or name',
      message: 'The "export" action requires a "sequenceId" or "name" parameter'
    });
  }

  const loadResult = await loadSequence({ name: args.name, sequenceId: args.sequenceId }, recorder);
  if (!loadResult.success) {
    return createErrorResponse(loadResult.errorCode, { message: loadResult.error });
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

async function handleLoad(args: ReplayArgs, recorder: CommandRecorder) {
  if (!args.filename) {
    return createErrorResponse('MISSING_PARAMETER', {
      action: 'load',
      missing: 'filename',
      message: 'The "load" action requires a "filename" parameter. Use listSaved to see available files.'
    });
  }

  const sequence = await recorder.loadSequenceFromDisk(args.filename);
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

async function handleListSaved(recorder: CommandRecorder) {
  const savedSequences = await recorder.listSavedSequencesOnDisk();
  return { content: [{ type: 'text', text: formatSavedSequencesList(savedSequences) }] };
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
  getPageForConnection: (connectionReason: string) => Promise<any>
) {
  // Load sequence
  const loadResult = await loadSequence({ name: args.name, sequenceId: args.sequenceId }, recorder);
  if (!loadResult.success) {
    return createErrorResponse(loadResult.errorCode, { message: loadResult.error });
  }

  const sequence = loadResult.sequence;
  const commands = sequence.commands;
  const analysis = analyzeSequenceConnections(commands);

  // Determine connection reason
  let connectionReason = args.connectionReason || extractConnectionFromSequence(commands, analysis);

  // Validate connection requirement
  const needsConnection = sequenceNeedsConnection(commands);
  if (!connectionReason && !analysis.hasLaunchBeforeConnection && needsConnection) {
    return createErrorResponse('MISSING_PARAMETER', {
      action: 'run',
      missing: 'connectionReason',
      message: 'The "run" action requires a "connectionReason" parameter to name the browser connection. Provide a connection name - the system will auto-launch Chrome if it doesn\'t exist. Alternatively: ensure sequence starts with launchChrome, or use replay({ action: \'get\', name: \'...\' }) to preview.'
    });
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
    logPrefix: 'run'
  };

  // Ensure connection is ready
  if (needsConnection && !analysis.hasLaunchBeforeConnection) {
    const connResult = await ensureConnection(ctx, needsConnection, analysis.hasLaunchBeforeConnection);
    if (!connResult.success) {
      return createErrorResponse('LAUNCH_FAILED', {
        message: connResult.error,
        suggestion: 'Launch Chrome manually first'
      });
    }
  }

  // Navigate to startUrl if needed
  const navResult = await navigateToStartUrl(ctx, sequence, analysis);
  if (!navResult.success) {
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

  // Calculate start step (convert 1-indexed to 0-indexed)
  const startStep = args.startFrom ? Math.max(0, args.startFrom - 1) : 0;

  // Validate startFrom
  if (args.startFrom && args.startFrom > sequence.commands.length) {
    return createErrorResponse('INVALID_START_FROM', {
      message: `startFrom (${args.startFrom}) exceeds sequence length (${sequence.commands.length})`
    });
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
    overrideConnectionReason: args.connectionReason
  });

  // Handle breakpoint hit
  if (execResult.breakpointHit && connectionReason) {
    return { content: [{ type: 'text', text: formatBreakpointHit(
      sequence.name,
      execResult.results,
      execResult.totalCommands,
      execResult.durationMs,
      execResult.breakpointHit,
      connectionReason
    ) }] };
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
    ) }] };
  }

  // Handle paused state (stepTo)
  if (execResult.pausedAtStep && execResult.activeSequenceState) {
    recorder.setActiveSequence(execResult.activeSequenceState);
    return { content: [{ type: 'text', text: formatPausedResponse(sequence, execResult.results, execResult.pausedAtStep, execResult.durationMs) }] };
  }

  // Clean up cursor
  if (cursorPage) {
    await removeReplayCursor(cursorPage);
    setReplayCursorCallbacks({});
  }

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

  return { content: [{ type: 'text', text: response }] };
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
    logPrefix: 'step'
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
    logPrefix: 'finish'
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
  getPageForConnection?: (connectionReason: string) => Promise<any>
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

  const page = await getPageForConnection(args.connectionReason);
  if (!page) {
    return createErrorResponse('CONNECTION_NOT_FOUND', {
      connectionReason: args.connectionReason,
      message: 'No browser connection found. Use launchChrome first.'
    });
  }

  const showOverlay = args.showOverlay !== false;
  const result = await startRecording(page, args.connectionReason, { showOverlay });

  if (!result.success) {
    return createErrorResponse('RECORDING_FAILED', { message: result.error });
  }

  let message = `**Recording started** (ID: ${result.id}) for \`${args.connectionReason}\`\n\n`;
  if (showOverlay) {
    message += `Overlay controls: **⏸** Pause | **↺** Reset | **✓** Complete\n\n`;
  }
  message += `Recording: mouse, keyboard, and navigation events.\n`;
  message += `Use \`stopInteraction\` when done - recording will be stored in memory.`;

  return {
    content: [{
      type: 'text',
      text: message
    }]
  };
}

async function handleStopInteraction(
  args: ReplayArgs,
  recorder: CommandRecorder,
  getPageForConnection?: (connectionReason: string) => Promise<any>
) {
  if (!args.connectionReason) {
    return createErrorResponse('MISSING_PARAMETER', {
      action: 'stopInteraction',
      missing: 'connectionReason',
      message: 'The "stopInteraction" action requires a "connectionReason" to identify the browser tab'
    });
  }

  if (!getPageForConnection) {
    return createErrorResponse('NOT_SUPPORTED', {
      message: 'Interaction recording is not supported in this context'
    });
  }

  const page = await getPageForConnection(args.connectionReason);
  if (!page) {
    return createErrorResponse('CONNECTION_NOT_FOUND', {
      connectionReason: args.connectionReason,
      message: 'No browser connection found.'
    });
  }

  const result = await stopRecording(page, args.connectionReason);

  if (!result.success) {
    return createErrorResponse('RECORDING_FAILED', { message: result.error });
  }

  const recording = result.recording!;
  const summary = recording.summary;

  // Convert events to commands and create a sequence
  const sequenceName = args.name || args.connectionReason;
  const commands = eventsToCommands(recording.events, {
    simplify: true,
    includeDelays: true,
    preferCoordinates: false,
    preferSelectors: false,
  });

  // Check if sequence name already exists
  if (recorder.sequenceNameExists(sequenceName) && !args.overwrite) {
    return createSuccessResponse('RECORDING_NAME_CONFLICT', {
      sequenceName,
      connectionReason: args.connectionReason
    });
  }

  // If overwriting, delete the existing sequence first
  if (args.overwrite && recorder.sequenceNameExists(sequenceName)) {
    const existingSeq = recorder.listSequences().find(s => s.name === sequenceName);
    if (existingSeq) {
      recorder.deleteSequence(existingSeq.id);
    }
  }

  const sequence = await recorder.createSequenceFromCommands(sequenceName, commands, {
    startUrl: recording.startUrl,
    description: `Recorded from ${args.connectionReason}`,
  });

  return createSuccessResponse('RECORDING_STOPPED', {
    name: sequence.name,
    sequenceId: sequence.id,
    duration: (recording.duration / 1000).toFixed(1),
    startUrl: recording.startUrl,
    commandCount: commands.length,
    clicks: summary.clicks,
    drags: summary.drags,
    scrolls: summary.scrolls,
    keyPresses: summary.keyPresses,
    navigations: summary.navigations > 0 ? summary.navigations : null,
    comments: summary.comments > 0 ? summary.comments : null
  });
}

function handleListInteractions() {
  const recordings = listRecordings();

  if (recordings.length === 0) {
    return {
      content: [{
        type: 'text',
        text: '**No stored recordings**\n\nUse `recordInteraction` to start recording.'
      }]
    };
  }

  let output = `**Stored Recordings** (${recordings.length})\n\n`;
  for (const r of recordings) {
    const date = new Date(r.startTime).toLocaleTimeString();
    output += `### Recording ${r.id}\n`;
    output += `- **Time:** ${date} (${(r.duration / 1000).toFixed(1)}s)\n`;
    output += `- **URL:** ${r.startUrl}\n`;
    output += `- **Events:** ${r.events.length} (${r.summary.clicks} clicks, ${r.summary.keyPresses} keys)\n\n`;
  }

  return { content: [{ type: 'text', text: output }] };
}

function handleGetInteraction(args: ReplayArgs) {
  if (args.recordingId === undefined) {
    return createErrorResponse('MISSING_PARAMETER', {
      action: 'getInteraction',
      missing: 'recordingId',
      message: 'The "getInteraction" action requires a "recordingId"'
    });
  }

  const recording = getRecording(args.recordingId);
  if (!recording) {
    return createErrorResponse('NOT_FOUND', {
      recordingId: args.recordingId,
      message: `Recording ${args.recordingId} not found. Use listInteractions to see available recordings.`
    });
  }

  const simplify = args.simplifyEvents !== false;
  const outputFormat = args.outputFormat || 'csv';
  const processedEvents = simplify ? simplifyEvents(recording.events) : recording.events;

  const conversionOptions: CommandConversionOptions = {
    simplify: false,
    includeHovers: args.includeHovers,
    preferCoordinates: args.preferCoordinates,
    preferSelectors: args.preferSelectors,
  };

  let output: string;

  if (outputFormat === 'review') {
    output = `**Recording ${recording.id}**\n\n`;
    output += `## Summary\n`;
    output += `- **Duration:** ${(recording.duration / 1000).toFixed(1)}s\n`;
    output += `- **Start URL:** ${recording.startUrl}\n`;
    output += `- **Events:** ${recording.events.length}${simplify ? ` (simplified to ${processedEvents.length})` : ''}\n`;
    output += `- **Clicks:** ${recording.summary.clicks}\n`;
    output += `- **Drags:** ${recording.summary.drags}\n`;
    output += `- **Scrolls:** ${recording.summary.scrolls}\n`;
    output += `- **Key presses:** ${recording.summary.keyPresses}\n`;
    if (recording.summary.navigations > 0) {
      output += `- **Navigations:** ${recording.summary.navigations}\n`;
    }
    if (recording.summary.comments > 0) {
      output += `- **Comments:** ${recording.summary.comments}\n`;
    }
    output += `\n## Events\n\n`;
    output += formatEventsForReview(processedEvents, recording.startTime);
    output += `\n---\n`;
    output += `**Export options:**\n`;
    output += `- \`getInteraction({ recordingId: ${recording.id}, outputFormat: "commands" })\`\n`;
    output += `- \`getInteraction({ recordingId: ${recording.id}, outputFormat: "puppeteer" })\`\n`;
    output += `- \`getInteraction({ recordingId: ${recording.id}, outputFormat: "playwright" })\`\n`;
  } else if (outputFormat === 'events') {
    output = `**Recording ${recording.id} - Raw Events**\n\n`;
    output += '```json\n';
    output += JSON.stringify(processedEvents.slice(0, 50), null, 2);
    if (processedEvents.length > 50) {
      output += `\n// ... and ${processedEvents.length - 50} more events`;
    }
    output += '\n```';
  } else if (outputFormat === 'puppeteer') {
    const commands = eventsToCommands(processedEvents, { ...conversionOptions, includeDelays: true });
    output = `**Recording ${recording.id} - Puppeteer Code**\n\n`;
    output += '```javascript\n';
    output += generatePuppeteerCode(commands, recording.startUrl);
    output += '\n```';
  } else if (outputFormat === 'playwright') {
    const commands = eventsToCommands(processedEvents, { ...conversionOptions, includeDelays: true });
    output = `**Recording ${recording.id} - Playwright Code**\n\n`;
    output += '```typescript\n';
    output += generatePlaywrightCode(commands, recording.startUrl);
    output += '\n```';
  } else if (outputFormat === 'commands') {
    const commands = eventsToCommands(processedEvents, conversionOptions);
    output = `**Recording ${recording.id} - Commands**\n\n`;
    output += '```json\n';
    output += JSON.stringify(commands, null, 2);
    output += '\n```';
  } else {
    // Default: CSV
    output = formatEventsAsCSV(processedEvents, recording.startTime);
  }

  return { content: [{ type: 'text', text: output }] };
}

function handleClearInteraction(args: ReplayArgs) {
  if (args.recordingId === undefined) {
    // Clear all
    const count = clearAllRecordings();
    return {
      content: [{
        type: 'text',
        text: `**Cleared ${count} recording${count !== 1 ? 's' : ''}**`
      }]
    };
  }

  const success = clearRecording(args.recordingId);
  if (!success) {
    return createErrorResponse('NOT_FOUND', {
      recordingId: args.recordingId,
      message: `Recording ${args.recordingId} not found`
    });
  }

  return {
    content: [{
      type: 'text',
      text: `**Recording ${args.recordingId} cleared**`
    }]
  };
}

async function handleReplayInteraction(
  args: ReplayArgs,
  commandRecorder: CommandRecorder,
  executeToolCall: (toolName: string, params: Record<string, any>) => Promise<any>,
  getPageForConnection?: (connectionReason: string) => Promise<any>
) {
  if (args.recordingId === undefined) {
    return createErrorResponse('MISSING_PARAMETER', {
      action: 'replayInteraction',
      missing: 'recordingId',
      message: 'The "replayInteraction" action requires a "recordingId" parameter'
    });
  }

  if (!args.connectionReason) {
    return createErrorResponse('MISSING_PARAMETER', {
      action: 'replayInteraction',
      missing: 'connectionReason',
      message: 'The "replayInteraction" action requires a "connectionReason" parameter'
    });
  }

  const recording = getRecording(args.recordingId);
  if (!recording) {
    return createErrorResponse('NOT_FOUND', {
      recordingId: args.recordingId,
      message: `Recording ${args.recordingId} not found. Use listInteractions to see available recordings.`
    });
  }

  // Convert events to commands with delays
  const commands = eventsToCommands(recording.events, {
    simplify: args.simplifyEvents !== false,
    includeHovers: args.includeHovers,
    preferCoordinates: args.preferCoordinates,
    preferSelectors: args.preferSelectors,
    includeDelays: true,
    startTime: recording.startTime,
  });

  if (commands.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `**Recording ${args.recordingId} has no replayable commands**`
      }]
    };
  }

  // Create a temporary sequence
  const sequence: CommandSequence = {
    id: `interaction-${args.recordingId}`,
    name: `Interaction Recording ${args.recordingId}`,
    description: `Replay of interaction recording ${args.recordingId}`,
    startUrl: recording.startUrl,
    commands,
    createdAt: Date.now(),
  };

  // Build execution context
  const ctx: ExecutionContext = {
    executeToolCall,
    commandRecorder,
    connectionReason: args.connectionReason,
    logPrefix: 'replayInteraction'
  };

  // Navigate to startUrl first
  if (recording.startUrl) {
    const navResult = await executeToolCall('navigate', {
      action: 'goto',
      connectionReason: args.connectionReason,
      url: recording.startUrl,
    });
    if (navResult?.isError) {
      return createErrorResponse('NAVIGATION_FAILED', {
        message: `Failed to navigate to ${recording.startUrl}`,
        startUrl: recording.startUrl
      });
    }
  }

  // Inject replay cursor if page is available
  let page: any = null;
  if (getPageForConnection) {
    try {
      page = await getPageForConnection(args.connectionReason);
      if (page) {
        await injectReplayCursor(page);
        // Set up cursor callbacks
        setReplayCursorCallbacks({
          onClickBefore: async (x: number, y: number, isRightClick: boolean) => {
            if (page) await showClickEffect(page, x, y, isRightClick);
          },
          onKeyPress: async (key: string) => {
            if (page) await showKeyPress(page, key);
          }
        });
      }
    } catch (e) {
      // Cursor injection is optional - continue without it
    }
  }

  // Execute the sequence
  const execResult = await executeSequenceWithPause({
    sequence,
    startStep: 0,
    ctx,
    record: true,
    stepTimeout: args.stepTimeout || 30000,
    totalTimeout: args.totalTimeout || 300000,
  });

  // Format results
  const successful = execResult.results.filter(r => r.success).length;
  const failed = execResult.results.filter(r => !r.success).length;
  const duration = (execResult.durationMs / 1000).toFixed(1);

  let output = `**Replay completed**\n\n`;
  output += `- **Recording:** ${args.recordingId}\n`;
  output += `- **Commands:** ${commands.length}\n`;
  output += `- **Successful:** ${successful}\n`;
  if (failed > 0) {
    output += `- **Failed:** ${failed}\n`;
  }
  output += `- **Duration:** ${duration}s\n`;

  if (failed > 0) {
    output += `\n**Failed steps:**\n`;
    for (const r of execResult.results.filter(r => !r.success)) {
      output += `- Step ${r.step}: ${r.error}\n`;
    }
  }

  // Clean up cursor
  if (page) {
    try {
      await removeReplayCursor(page);
      setReplayCursorCallbacks({});
    } catch (e) {
      // Ignore cleanup errors
    }
  }

  return { content: [{ type: 'text', text: output }] };
}

// Legacy handlers - delegate to new ones
async function handleStartMouseRecording(
  args: ReplayArgs,
  getPageForConnection?: (connectionReason: string) => Promise<any>
) {
  return handleRecordInteraction(args, getPageForConnection);
}

async function handleStopMouseRecording(
  args: ReplayArgs,
  recorder: CommandRecorder,
  getPageForConnection?: (connectionReason: string) => Promise<any>
) {
  // Legacy - stop and immediately return results (old behavior)
  // Use the new stopInteraction to store in memory instead
  return handleStopInteraction(args, recorder, getPageForConnection);
}

async function handleMouseRecordingStatus(
  args: ReplayArgs,
  getPageForConnection?: (connectionReason: string) => Promise<any>
) {
  if (!args.connectionReason) {
    return createErrorResponse('MISSING_PARAMETER', {
      action: 'mouseRecordingStatus',
      missing: 'connectionReason',
      message: 'The "mouseRecordingStatus" action requires a "connectionReason" to identify the browser tab'
    });
  }

  if (!getPageForConnection) {
    return createErrorResponse('NOT_SUPPORTED', {
      message: 'Mouse recording is not supported in this context'
    });
  }

  const page = await getPageForConnection(args.connectionReason);
  if (!page) {
    return createErrorResponse('CONNECTION_NOT_FOUND', {
      connectionReason: args.connectionReason,
      message: 'No browser connection found.'
    });
  }

  const status = await getRecordingStatus(page, args.connectionReason);

  if (!status.isRecording) {
    return {
      content: [{
        type: 'text',
        text: `**No active mouse recording** for \`${args.connectionReason}\`\n\nUse \`startMouseRecording\` to begin recording.`
      }]
    };
  }

  return {
    content: [{
      type: 'text',
      text: `**Mouse recording active** for \`${args.connectionReason}\`\n\n**Duration:** ${((status.duration || 0) / 1000).toFixed(1)}s\n**Events captured:** ${status.eventCount || 'unknown'}`
    }]
  };
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
          lines.push(`  await page.keyboard.type('${params.text}');`);
          lines.push('');
          break;

        case 'press':
          lines.push(`  await page.keyboard.press('${params.key}');`);
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
          lines.push(`  await page.keyboard.type('${params.text}');`);
          lines.push('');
          break;

        case 'press':
          lines.push(`  await page.keyboard.press('${params.key}');`);
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
  getPageForConnection?: (connectionReason: string) => Promise<any>
) {
  return {
    replay: createTool(
      'Record and replay command sequences for testing and automation. Actions: repeat (immediately execute commands by history indices - use this to repeat recent actions), history (view command history), create (create sequence from indices), list (list in-memory sequences), get (get sequence details), delete (delete from memory), save (save sequence to disk), load (load sequence from disk), listSaved (list saved files), deleteSaved (delete saved file), run (load and execute sequence from disk in one step), step (execute next N commands in paused sequence), finish (complete remaining commands), insert (insert recorded commands into sequence), status (show active sequence status), startMouseRecording (start recording mouse events), stopMouseRecording (stop recording and get events), mouseRecordingStatus (check recording status)',
      replaySchema,
      async (args) => {
        switch (args.action) {
          case 'history':
            return handleHistory(args, commandRecorder);
          case 'create':
            return handleCreate(args, commandRecorder);
          case 'list':
            return handleList(commandRecorder);
          case 'get':
            return handleGet(args, commandRecorder);
          case 'delete':
            return handleDelete(args, commandRecorder);
          case 'export':
            return handleExport(args, commandRecorder);
          case 'load':
            return handleLoad(args, commandRecorder);
          case 'listSaved':
            return handleListSaved(commandRecorder);
          case 'deleteSaved':
            return handleDeleteSaved(args, commandRecorder);
          case 'run':
            return handleRun(args, commandRecorder, executeToolCall, getPageForConnection!);
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
          case 'startMouseRecording':
            return handleStartMouseRecording(args, getPageForConnection);
          case 'stopMouseRecording':
            return handleStopMouseRecording(args, commandRecorder, getPageForConnection);
          case 'mouseRecordingStatus':
            return handleMouseRecordingStatus(args, getPageForConnection);
          case 'recordInteraction':
            return handleRecordInteraction(args, getPageForConnection);
          case 'stopInteraction':
            return handleStopInteraction(args, commandRecorder, getPageForConnection);
          case 'listInteractions':
            return handleListInteractions();
          case 'getInteraction':
            return handleGetInteraction(args);
          case 'clearInteraction':
            return handleClearInteraction(args);
          case 'replayInteraction':
            return handleReplayInteraction(args, commandRecorder, executeToolCall, getPageForConnection);
          default:
            return createErrorResponse('INVALID_ACTION', { action: args.action });
        }
      }
    ),
  };
}
