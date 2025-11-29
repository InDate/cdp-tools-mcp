/**
 * Replay Formatters - Response formatting for replay tool actions
 */

import type { RecordedCommand, CommandSequence, ActiveSequenceState } from '../command-recorder.js';
import type { StepResult, DebugState, BreakpointHitInfo, ClickValidationFailure } from './replay-executor.js';
import { getFormattedResponse } from '../messages.js';

// =============================================================================
// Result Formatting
// =============================================================================

/**
 * Format execution results for display
 */
export function formatExecutionResults(
  sequenceName: string,
  results: StepResult[],
  totalCommands: number,
  durationMs: number
): string {
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;

  let response: string;

  if (failed > 0) {
    const failedResult = results.find(r => !r.success)!;
    response = getFormattedResponse('REPLAY_RUN_FAILED', {
      sequenceName,
      failedStep: failedResult.step,
      failedTool: failedResult.tool
    });
  } else {
    response = getFormattedResponse('REPLAY_RUN_SUCCESS', {
      sequenceName,
      successful,
      total: totalCommands,
      duration: (durationMs / 1000).toFixed(1)
    });
  }

  // Stats section
  response += `\n\n**Executed:** ${results.length} of ${totalCommands} commands`;
  response += `\n**Successful:** ${successful}`;
  response += `\n**Failed:** ${failed}`;
  response += `\n**Duration:** ${(durationMs / 1000).toFixed(1)}s`;

  if (failed > 0) {
    response += `\n\n**Failed Commands**\n`;
    results.filter(r => !r.success).forEach((r) => {
      if (r.tool === 'conditional' && r.substeps) {
        response += `${r.step}. **${r.tool}** (${r.sequenceName})\n`;
        response += `   **Error:** ${r.error}\n`;
        // Show substeps - but skip redundant error messages
        r.substeps.forEach((sub) => {
          const icon = sub.success ? '✓' : '✗';
          response += `   ${r.step}.${sub.step}. ${sub.tool} ${icon}`;
          // Only show substep error if it's different from the parent error
          if (!sub.success && sub.error && sub.error !== r.error) {
            response += ` - ${sub.error}`;
          }
          response += `\n`;
        });
        response += `\n`;
      } else {
        response += `${r.step}. **${r.tool}**\n`;
        response += `   **Error:** ${r.error}\n\n`;
      }
    });
  }

  if (successful > 0) {
    response += `\n\n**Successful Commands**\n`;
    results.filter(r => r.success).forEach((r) => {
      if (r.tool === 'conditional') {
        // Format conditional with substeps
        if (r.conditionMet && r.substeps && r.substeps.length > 0) {
          response += `${r.step}. **${r.tool}** (${r.sequenceName}) ✓ - ran ${r.substeps.length} substeps\n`;
          r.substeps.forEach((sub) => {
            const icon = sub.success ? '✓' : '✗';
            response += `   ${r.step}.${sub.step}. ${sub.tool} ${icon}\n`;
          });
        } else {
          // Skipped because condition not met (not an error, just false)
          response += `${r.step}. **${r.tool}** (${r.sequenceName}) ○ - skipped (condition not met)\n`;
        }
      } else {
        response += `${r.step}. **${r.tool}** ✓\n`;
      }
    });
  }

  return response;
}

/**
 * Format paused sequence response
 */
export function formatPausedResponse(
  sequence: CommandSequence,
  results: StepResult[],
  pausedAtStep: number,
  durationMs: number
): string {
  const commands = sequence.commands;
  const successful = results.filter(r => r.success).length;
  const remaining = commands.length - pausedAtStep;

  let response = getFormattedResponse('REPLAY_PAUSED', {
    sequenceName: sequence.name,
    pausedStep: pausedAtStep,
    total: commands.length,
    remaining
  });

  response += `\n\n**Executed:** ${successful} commands in ${(durationMs / 1000).toFixed(1)}s`;

  response += `\n\n**Completed Steps**\n`;
  results.forEach((r) => {
    response += `${r.step}. **${r.tool}** ✓\n`;
  });

  response += `\n**Next Steps**\n`;
  for (let j = pausedAtStep; j < Math.min(pausedAtStep + 3, commands.length); j++) {
    response += `${j + 1}. **${commands[j].tool}**\n`;
  }
  if (commands.length > pausedAtStep + 3) {
    response += `... and ${commands.length - pausedAtStep - 3} more\n`;
  }

  response += `\n---\n\n**Actions**\n`;
  response += `- Continue: \`replay({ action: 'step' })\` or \`replay({ action: 'step', stepCount: N })\`\n`;
  response += `- Finish all: \`replay({ action: 'finish' })\`\n`;
  response += `- Check status: \`replay({ action: 'status' })\`\n`;
  response += `- Insert commands: \`replay({ action: 'insert' })\`\n`;

  return response;
}

/**
 * Format click validation failure response (paused for inspection/retry)
 */
export function formatClickValidationFailure(
  sequence: CommandSequence,
  results: StepResult[],
  pausedAtStep: number,
  durationMs: number,
  failure: ClickValidationFailure,
  connectionReason: string
): string {
  const commands = sequence.commands;
  const successful = results.filter(r => r.success).length;
  const remaining = commands.length - pausedAtStep;

  let response = `**Click Validation Failed**\n`;
  response += `${sequence.name}: Paused at step ${pausedAtStep} of ${commands.length}, ${remaining} remaining\n\n`;

  response += `**Executed:** ${successful} commands in ${(durationMs / 1000).toFixed(1)}s\n\n`;

  response += `**Validation Error at Step ${failure.step}**\n`;
  response += `- Selector: \`${failure.selector}\`\n`;
  for (const err of failure.errors) {
    response += `- ❌ ${err}\n`;
  }
  for (const warn of failure.warnings) {
    response += `- ⚠️ ${warn}\n`;
  }
  if (failure.info?.length > 0) {
    for (const infoMsg of failure.info) {
      response += `- ℹ️ ${infoMsg}\n`;
    }
  }

  response += `\n**Completed Steps**\n`;
  results.filter(r => r.success).forEach((r) => {
    response += `${r.step}. **${r.tool}** ✓\n`;
  });

  response += `\n---\n\n**Actions**\n`;
  response += `- Inspect error: \`console({ action: 'list', type: 'error', connectionReason: '${connectionReason}' })\`\n`;
  response += `- Retry step: \`replay({ action: 'step' })\`\n`;
  response += `- Skip and continue: \`replay({ action: 'step', stepCount: 2 })\`\n`;
  response += `- Finish remaining: \`replay({ action: 'finish' })\`\n`;
  response += `- Cancel: \`replay({ action: 'cancel' })\`\n`;

  return response;
}

/**
 * Format breakpoint hit response
 */
export function formatBreakpointHit(
  sequenceName: string,
  results: StepResult[],
  totalCommands: number,
  durationMs: number,
  breakpointInfo: BreakpointHitInfo,
  connectionReason: string
): string {
  const location = `${breakpointInfo.url}:${breakpointInfo.lineNumber}`;

  let response = getFormattedResponse('REPLAY_BREAKPOINT_HIT', {
    sequenceName,
    location,
    step: results.length,
    total: totalCommands
  });

  response += `\n\n**Location:** \`${breakpointInfo.url}:${breakpointInfo.lineNumber}\``;
  if (breakpointInfo.functionName) {
    response += `\n**Function:** \`${breakpointInfo.functionName}\``;
  }
  response += `\n**Step:** ${results.length} of ${totalCommands}`;
  response += `\n**Duration:** ${(durationMs / 1000).toFixed(1)}s`;

  response += `\n\n**Completed Steps**\n`;
  results.forEach((r) => {
    response += `${r.step}. **${r.tool}** ✓\n`;
  });

  response += `\n---\n\n**Debug Actions**\n`;
  response += `- Inspect call stack: \`inspect({ action: 'getCallStack', connectionReason: '${connectionReason}' })\`\n`;
  response += `- Get variables: \`inspect({ action: 'getVariables', connectionReason: '${connectionReason}', callFrameId: '<from call stack>' })\`\n`;
  response += `- Resume execution: \`execution({ action: 'resume', connectionReason: '${connectionReason}' })\`\n`;
  response += `- Step over: \`execution({ action: 'stepOver', connectionReason: '${connectionReason}' })\`\n`;

  return response;
}

/**
 * Format debug state section
 */
export function formatDebugState(debugState: DebugState, connectionReason: string): string {
  if (!debugState.isPaused && debugState.breakpointCount === 0) {
    return '';
  }

  let section = `\n\n**Debug State**\n`;

  if (debugState.isPaused) {
    section += `\n**Execution paused** at ${debugState.pauseLocation}\n\n`;
    section += `**Next steps:**\n`;
    section += `- Inspect call stack: \`inspect({ action: 'getCallStack', connectionReason: '${connectionReason}' })\`\n`;
    section += `- Get variables: \`inspect({ action: 'getVariables', connectionReason: '${connectionReason}', callFrameId: '<from call stack>' })\`\n`;
    section += `- Resume execution: \`execution({ action: 'resume', connectionReason: '${connectionReason}' })\`\n`;
    section += `- Step over: \`execution({ action: 'stepOver', connectionReason: '${connectionReason}' })\`\n`;
  }

  if (debugState.breakpointCount > 0) {
    section += `\n**${debugState.breakpointCount} active breakpoint${debugState.breakpointCount > 1 ? 's' : ''}**\n`;
    section += `- List breakpoints: \`breakpoint({ action: 'list', connectionReason: '${connectionReason}' })\`\n`;
    section += `- Remove all: \`breakpoint({ action: 'remove', connectionReason: '${connectionReason}', breakpointId: '<id>' })\`\n`;
  }

  return section;
}

// =============================================================================
// Variable Formatting
// =============================================================================

interface ExtractedVariable {
  value: string;
  locations: string[];
}

/**
 * Extract customizable text variables from sequence commands
 */
export function extractTextVariables(commands: RecordedCommand[]): Record<string, ExtractedVariable> {
  const variables: Record<string, ExtractedVariable> = {};

  commands.forEach((cmd, cmdIdx) => {
    if (cmd.tool === 'input' && cmd.params.action === 'type' && cmd.params.text) {
      const varName = `var_${cmdIdx}_${cmd.params.selector?.replace(/[^a-zA-Z0-9]/g, '_') || 'text'}`;
      if (!variables[varName]) {
        variables[varName] = { value: cmd.params.text, locations: [] };
      }
      variables[varName].locations.push(`Command ${cmdIdx + 1}: ${cmd.tool} -> ${cmd.params.selector}`);
    }
  });

  return variables;
}

/**
 * Format variable prompt for user to customize values before execution
 */
export function formatVariablePrompt(
  sequenceName: string,
  sequenceIdOrName: string,
  variables: Record<string, ExtractedVariable>,
  connectionReason: string | undefined
): string {
  let response = getFormattedResponse('REPLAY_VARIABLE_PROMPT', {
    sequenceName,
    variableCount: Object.keys(variables).length
  });

  response += `\n\n**Customizable text parameter(s):**\n`;
  Object.entries(variables).forEach(([varName, data]) => {
    response += `- \`${varName}\`: "${data.value}"\n`;
  });

  response += `\n**Execute:**\n\n`;
  response += `**Option 1: Keep original values**\n`;
  response += `\`\`\`javascript\n`;
  response += `replay({ action: 'run', name: '${sequenceIdOrName}'`;
  if (connectionReason) {
    response += `, connectionReason: '${connectionReason}'`;
  }
  response += `, variables: {} })\n`;
  response += `\`\`\`\n\n`;

  response += `**Option 2: Custom values** (replace variable values as needed)\n`;
  response += `\`\`\`javascript\n`;
  response += `replay({ action: 'run', name: '${sequenceIdOrName}'`;
  if (connectionReason) {
    response += `, connectionReason: '${connectionReason}'`;
  }
  response += `, variables: {\n`;
  Object.keys(variables).forEach((varName, idx, arr) => {
    response += `  "${varName}": "custom-value"${idx < arr.length - 1 ? ',' : ''}\n`;
  });
  response += `} })\n`;
  response += `\`\`\``;

  return response;
}

// =============================================================================
// History & Sequence Formatting
// =============================================================================

interface HistoryCommand {
  index: number;
  tool: string;
  params: Record<string, any>;
}

/**
 * Format command history listing
 */
export function formatHistory(
  history: HistoryCommand[],
  totalCount: number
): string {
  if (history.length === 0) {
    return getFormattedResponse('REPLAY_HISTORY_EMPTY', {});
  }

  // Use message template for first two lines
  let response = getFormattedResponse('REPLAY_HISTORY', {
    count: history.length,
    totalCount: totalCount
  });

  history.forEach((cmd) => {
    const paramStr = JSON.stringify(cmd.params);
    const truncatedParams = paramStr.length > 60 ? paramStr.slice(0, 60) + '...' : paramStr;
    response += `\n${cmd.index}. **${cmd.tool}** - ${truncatedParams}`;
  });

  response += `\n\n---\n\nCreate sequence: \`replay({ action: 'create', name: '...', indices: [${history.slice(0, 3).map(c => c.index).join(', ')}] })\``;

  return response;
}

/**
 * Format sequence created response
 */
export function formatSequenceCreated(sequence: CommandSequence): string {
  let response = getFormattedResponse('REPLAY_SEQUENCE_CREATED', {
    name: sequence.name,
    id: sequence.id,
    commandCount: sequence.commands.length
  });

  // Optional metadata
  let hasMetadata = false;
  if (sequence.description) {
    response += `${hasMetadata ? '\n' : '\n\n'}**Description:** ${sequence.description}`;
    hasMetadata = true;
  }
  if (sequence.expectedOutcome) {
    response += `${hasMetadata ? '\n' : '\n\n'}**Expected Outcome:** ${sequence.expectedOutcome}`;
    hasMetadata = true;
  }
  if (sequence.startUrl) {
    response += `${hasMetadata ? '\n' : '\n\n'}**Start URL:** ${sequence.startUrl}`;
    hasMetadata = true;
  }

  response += `\n\n**Commands in Sequence**\n`;
  sequence.commands.forEach((cmd, idx) => {
    response += `${idx + 1}. **${cmd.tool}**\n`;
    response += `\`\`\`json\n${JSON.stringify(cmd.params, null, 2)}\n\`\`\`\n\n`;
  });

  response += `---\n\n`;
  response += `**Run this sequence:**\n`;
  response += `\`replay({ action: 'run', sequenceId: '${sequence.id}' })\``;

  return response;
}

/**
 * Format sequence list
 */
export function formatSequenceList(sequences: CommandSequence[]): string {
  if (sequences.length === 0) {
    let response = getFormattedResponse('REPLAY_SEQUENCE_LIST_EMPTY', {});
    response += `\n\n**Create a sequence:**\n`;
    response += `1. View command history: \`replay({ action: 'history' })\`\n`;
    response += `2. Create sequence: \`replay({ action: 'create', name: 'my-workflow', indices: [1, 2, 3] })\``;
    return response;
  }

  let response = getFormattedResponse('REPLAY_SEQUENCE_LIST', {
    count: sequences.length
  });

  sequences.forEach((seq, idx) => {
    const age = Math.floor((Date.now() - seq.createdAt) / 1000 / 60);
    response += `\n\n**${idx + 1}. ${seq.name}**\n`;
    response += `- **ID:** \`${seq.id}\`\n`;
    if (seq.description) {
      response += `- **Description:** ${seq.description}\n`;
    }
    if (seq.expectedOutcome) {
      response += `- **Expected Outcome:** ${seq.expectedOutcome}\n`;
    }
    if (seq.startUrl) {
      response += `- **Start URL:** ${seq.startUrl}\n`;
    }
    response += `- **Commands:** ${seq.commands.length}\n`;
    response += `- **Created:** ${age} minutes ago`;
  });

  response += `\n\n---\n\n`;
  response += `**Actions:**\n`;
  response += `- View details: \`replay({ action: 'get', sequenceId: 'seq-id' })\`\n`;
  response += `- Execute: \`replay({ action: 'run', sequenceId: 'seq-id' })\`\n`;
  response += `- Delete: \`replay({ action: 'delete', sequenceId: 'seq-id' })\``;

  return response;
}

/**
 * Format sequence details
 */
export function formatSequenceDetails(sequence: CommandSequence): string {
  let response = getFormattedResponse('REPLAY_SEQUENCE_DETAILS', {
    name: sequence.name,
    commandCount: sequence.commands.length
  });

  response += `\n\n**ID:** \`${sequence.id}\``;
  if (sequence.description) {
    response += `\n**Description:** ${sequence.description}`;
  }
  if (sequence.expectedOutcome) {
    response += `\n**Expected Outcome:** ${sequence.expectedOutcome}`;
  }
  if (sequence.startUrl) {
    response += `\n**Start URL:** ${sequence.startUrl}`;
  }
  response += `\n**Created:** ${new Date(sequence.createdAt).toLocaleString()}`;

  // Show variables if any exist
  const variables = extractTextVariables(sequence.commands);
  if (Object.keys(variables).length > 0) {
    response += `\n\n**Variables (${Object.keys(variables).length}):**\n`;
    Object.entries(variables).forEach(([varName, data]) => {
      response += `- \`${varName}\`: "${data.value}"\n`;
    });
  }

  response += `\n\n**Commands**\n`;
  sequence.commands.forEach((cmd: RecordedCommand, idx: number) => {
    response += `### ${idx + 1}. ${cmd.tool}\n`;
    response += `**Parameters:**\n\`\`\`json\n${JSON.stringify(cmd.params, null, 2)}\n\`\`\`\n\n`;
  });

  response += `---\n\n`;
  response += `**Run:** \`replay({ action: 'run', name: '${sequence.name}' })\``;

  return response;
}

/**
 * Format saved sequences on disk listing
 */
export function formatSavedSequencesList(
  sequences: Array<{ filename: string; name: string; id: string; commandCount: number; description?: string; expectedOutcome?: string; startUrl?: string; location?: string; fullPath?: string }>
): string {
  if (sequences.length === 0) {
    return getFormattedResponse('REPLAY_SAVED_EMPTY', {});
  }

  // Sort by ID timestamp (oldest first) - ID format is "seq-{timestamp}"
  const sorted = [...sequences].sort((a, b) => {
    const tsA = parseInt((a.id || '').replace('seq-', ''), 10) || 0;
    const tsB = parseInt((b.id || '').replace('seq-', ''), 10) || 0;
    return tsA - tsB;
  });

  // Use message template for first two lines
  let response = getFormattedResponse('REPLAY_SAVED_LIST', {
    count: sorted.length
  });

  response += '\n';

  sorted.forEach((seq, idx) => {
    const locationTag = seq.location === 'global' ? ' [global]' : '';
    response += `${idx + 1}. ${seq.name} (${seq.commandCount})${locationTag}\n`;
  });

  response += `\nRun: \`replay({ action: 'run', name: '<name>' })\``;

  return response;
}

// =============================================================================
// Status & Step Formatting
// =============================================================================

/**
 * Format active sequence status
 */
export function formatActiveStatus(
  activeSeq: ActiveSequenceState,
  commandsSincePause: HistoryCommand[]
): string {
  const pausedDuration = Math.round((Date.now() - activeSeq.pausedAt) / 1000);

  let response = getFormattedResponse('REPLAY_ACTIVE_STATUS', {
    sequenceName: activeSeq.sequenceName,
    currentStep: activeSeq.currentStep,
    totalSteps: activeSeq.totalSteps
  });

  response += `\n\n**Connection:** ${activeSeq.connectionReason || 'none'}`;
  response += `\n**Paused for:** ${pausedDuration}s`;

  if (commandsSincePause.length > 0) {
    response += `\n\n**Commands Since Pause (${commandsSincePause.length})**\n`;
    commandsSincePause.forEach((cmd, idx) => {
      response += `${idx + 1}. [#${cmd.index}] **${cmd.tool}**\n`;
    });
  }

  response += `\n---\n\n**Actions**\n`;
  response += `- Continue: \`replay({ action: 'step' })\`\n`;
  response += `- Finish all: \`replay({ action: 'finish' })\`\n`;
  if (commandsSincePause.length > 0) {
    response += `- Insert commands: \`replay({ action: 'insert' })\`\n`;
  }

  return response;
}

/**
 * Format step execution results
 */
export function formatStepResults(
  sequenceName: string,
  results: StepResult[],
  startStep: number,
  totalCommands: number,
  failed: boolean
): string {
  let response: string;

  if (failed) {
    const failedResult = results.find(r => !r.success)!;
    response = getFormattedResponse('REPLAY_STEP_FAILED', {
      sequenceName,
      failedStep: failedResult.step,
      failedTool: failedResult.tool
    });
    response += `\n\n**Error:** ${failedResult.error}`;
    response += `\n\nSequence cancelled due to error.`;
  } else {
    const lastExecuted = results.length > 0 ? results[results.length - 1].step : startStep;
    const remaining = totalCommands - lastExecuted;

    if (lastExecuted >= totalCommands) {
      response = getFormattedResponse('REPLAY_STEP_COMPLETE', {
        sequenceName,
        total: totalCommands
      });
    } else {
      response = getFormattedResponse('REPLAY_STEP_SUCCESS', {
        sequenceName,
        stepCount: results.length,
        remaining
      });

      response += `\n\n**Executed Steps**\n`;
      results.forEach(r => {
        response += `${r.step}. **${r.tool}** ✓\n`;
      });

      response += `\n---\n\n**Actions**\n`;
      response += `- Continue: \`replay({ action: 'step' })\`\n`;
      response += `- Finish all: \`replay({ action: 'finish' })\`\n`;
    }
  }

  return response;
}

// =============================================================================
// Insert Formatting
// =============================================================================

/**
 * Format insert prompt (when no indices provided)
 */
export function formatInsertPrompt(
  sequenceName: string,
  commandsSincePause: HistoryCommand[],
  currentStep: number,
  totalSteps: number
): string {
  if (commandsSincePause.length === 0) {
    return getFormattedResponse('REPLAY_NO_COMMANDS_SINCE_PAUSE', {});
  }

  let response = getFormattedResponse('REPLAY_INSERT_PROMPT', {
    sequenceName,
    commandCount: commandsSincePause.length
  });

  response += `\n\n**Commands recorded since pause:**\n`;
  commandsSincePause.forEach((cmd) => {
    response += `- [#${cmd.index}] **${cmd.tool}**`;
    if (cmd.params && Object.keys(cmd.params).length > 0) {
      const paramStr = JSON.stringify(cmd.params);
      response += ` - ${paramStr.length > 50 ? paramStr.slice(0, 50) + '...' : paramStr}`;
    }
    response += `\n`;
  });

  response += `\n**Current position:** After step ${currentStep} of ${totalSteps}`;

  response += `\n\n**Insert Options**\n\n`;
  response += `**Insert all commands:**\n`;
  response += `\`\`\`\nreplay({ action: 'insert', insertIndices: [${commandsSincePause.map(c => c.index).join(', ')}], overwrite: true })\n\`\`\`\n\n`;
  response += `**Or select specific indices and optionally save as new sequence:**\n`;
  response += `\`\`\`\nreplay({ action: 'insert', insertIndices: [${commandsSincePause[0]?.index || 0}], newName: 'updated-sequence' })\n\`\`\`\n`;

  return response;
}

/**
 * Format insert result
 */
export function formatInsertResult(
  sequenceName: string,
  sequenceId: string,
  insertedCount: number,
  insertAfter: number,
  newTotal: number,
  isOverwrite: boolean
): string {
  let response: string;

  if (isOverwrite) {
    response = getFormattedResponse('REPLAY_INSERT_SUCCESS', {
      sequenceName,
      insertedCount,
      insertAfter
    });
    response += `\n\n**New total:** ${newTotal} commands`;
  } else {
    response = getFormattedResponse('REPLAY_INSERT_NEW', {
      sequenceName,
      insertedCount
    });
    response += `\n\n**Inserted after step:** ${insertAfter}`;
    response += `\n**Total commands:** ${newTotal}`;
  }

  response += `\n\nSave to disk: \`replay({ action: 'save', sequenceId: '${sequenceId}' })\``;
  return response;
}
