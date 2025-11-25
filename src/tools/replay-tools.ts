/**
 * Command Replay Tools - Action router for sequence recording and playback
 */

import { z } from 'zod';
import type { CommandRecorder } from '../command-recorder.js';
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
  executeCommandWithRetry,
  getDebugState,
  TOOLS_NEEDING_CONNECTION,
  type ExecutionContext,
} from './replay-executor.js';

import {
  formatExecutionResults,
  formatPausedResponse,
  formatDebugState,
  formatBreakpointHit,
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

// =============================================================================
// Schema Definition
// =============================================================================

const replaySchema = z.object({
  action: z.enum([
    'history', 'create', 'list', 'get', 'delete',
    'save', 'load', 'listSaved', 'deleteSaved',
    'run', 'step', 'finish', 'insert', 'status', 'cancel'
  ]).describe(
    'Replay action: history (view command history), create (create sequence from indices), list (list in-memory sequences), get (get sequence details), delete (delete from memory), save (save to disk), load (load from disk), listSaved (list saved files), deleteSaved (delete saved file), run (execute sequence by name or sequenceId), step (execute next N commands in paused sequence), finish (complete remaining commands), insert (insert recorded commands into sequence), status (show active sequence status), cancel (abandon paused sequence)'
  ),

  // history parameters
  limit: z.number().optional().describe('Number of recent commands to show (for history action, default: 50)'),

  // create/run parameters
  name: z.string().optional().describe('Name for the sequence (for create action), or sequence name to run (for run action)'),
  description: z.string().optional().describe('Description of what the sequence does (for create action)'),
  expectedOutcome: z.string().optional().describe('Expected outcome when the sequence runs successfully (for create action)'),
  startUrl: z.string().optional().describe('Starting URL for the sequence (for create action). Auto-extracted from first navigate goto if not provided.'),
  indices: z.array(z.number()).optional().describe('Command indices to include in sequence (for create action)'),

  // get/delete/run/save parameters
  sequenceId: z.string().optional().describe('Sequence ID (for get, delete, run, save actions)'),

  // load/deleteSaved parameters
  filename: z.string().optional().describe('Filename (for load, deleteSaved actions)'),
  intoHistory: z.boolean().optional().describe('Load sequence commands into history without executing (for load action, default: false)'),

  // run parameters
  connectionReason: z.string().optional().describe('Connection reference to use for all commands in replay'),
  record: z.boolean().optional().describe('Record replayed commands into current recording session (for run action, default: false)'),
  variables: z.record(z.string()).optional().describe('Variable substitutions for text parameters (for run action). Keys are variable names, values are replacement text. Empty object means keep original values.'),
  stepTimeout: z.number().optional().describe('Timeout in milliseconds for each step (for run action, default: 30000)'),
  totalTimeout: z.number().optional().describe('Total timeout in milliseconds for entire run (for run action, default: 300000)'),

  // step-through parameters
  stepTo: z.number().optional().describe('Execute sequence up to this step number (1-indexed), then pause (for run action)'),
  stepCount: z.number().optional().describe('Number of commands to execute (for step action, default: 1)'),

  // insert parameters
  insertIndices: z.array(z.number()).optional().describe('History indices of commands to insert (for insert action)'),
  insertAfterStep: z.number().optional().describe('Insert commands after this step number in sequence (for insert action)'),
  overwrite: z.boolean().optional().describe('Overwrite existing sequence instead of creating new (for insert action, default: false)'),
  newName: z.string().optional().describe('Name for new sequence when not overwriting (for insert action)'),
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

  return { content: [{ type: 'text', text: formatSequenceDetails(loadResult.sequence) }] };
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

async function handleSave(args: ReplayArgs, recorder: CommandRecorder) {
  if (!args.sequenceId) {
    return createErrorResponse('MISSING_PARAMETER', {
      action: 'save',
      missing: 'sequenceId',
      message: 'The "save" action requires a "sequenceId" parameter'
    });
  }

  const filepath = await recorder.saveSequenceToDisk(args.sequenceId);
  if (!filepath) {
    return createErrorResponse('SAVE_FAILED', {
      sequenceId: args.sequenceId,
      message: 'Failed to save sequence to disk. Sequence may not exist.'
    });
  }

  return createSuccessResponse('SEQUENCE_SAVED_TO_DISK', {
    sequenceId: args.sequenceId,
    filename: filepath,
    message: `Sequence saved to: ${filepath}`
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
  executeToolCall: (toolName: string, params: Record<string, any>) => Promise<any>
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

  // Execute the sequence
  const execResult = await executeSequenceWithPause({
    sequence,
    startStep: 0,
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

  // Handle paused state (stepTo)
  if (execResult.pausedAtStep && execResult.activeSequenceState) {
    recorder.setActiveSequence(execResult.activeSequenceState);
    return { content: [{ type: 'text', text: formatPausedResponse(sequence, execResult.results, execResult.pausedAtStep, execResult.durationMs) }] };
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
// Tool Export
// =============================================================================

export function createReplayTools(
  commandRecorder: CommandRecorder,
  executeToolCall: (toolName: string, params: Record<string, any>) => Promise<any>
) {
  return {
    replay: createTool(
      'Record and replay command sequences for testing and automation. Actions: history (view command history), create (create sequence from indices), list (list in-memory sequences), get (get sequence details), delete (delete from memory), save (save sequence to disk), load (load sequence from disk), listSaved (list saved files), deleteSaved (delete saved file), run (load and execute sequence from disk in one step), step (execute next N commands in paused sequence), finish (complete remaining commands), insert (insert recorded commands into sequence), status (show active sequence status)',
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
          case 'save':
            return handleSave(args, commandRecorder);
          case 'load':
            return handleLoad(args, commandRecorder);
          case 'listSaved':
            return handleListSaved(commandRecorder);
          case 'deleteSaved':
            return handleDeleteSaved(args, commandRecorder);
          case 'run':
            return handleRun(args, commandRecorder, executeToolCall);
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
          default:
            return createErrorResponse('INVALID_ACTION', { action: args.action });
        }
      }
    ),
  };
}
