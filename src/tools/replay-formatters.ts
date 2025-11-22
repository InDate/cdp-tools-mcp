/**
 * Replay Formatters - Response formatting for replay tool actions
 */

import type { RecordedCommand, CommandSequence, ActiveSequenceState } from '../command-recorder.js';
import type { StepResult, DebugState, BreakpointHitInfo } from './replay-executor.js';

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

  let response = `# Run Results: ${sequenceName}\n\n`;
  response += `**Executed:** ${results.length} of ${totalCommands} commands\n`;
  response += `**Successful:** ${successful}\n`;
  response += `**Failed:** ${failed}\n`;
  response += `**Duration:** ${(durationMs / 1000).toFixed(1)}s\n\n`;

  if (failed > 0) {
    response += `## Failed Commands\n\n`;
    results.filter(r => !r.success).forEach((r) => {
      response += `${r.step}. **${r.tool}**\n`;
      response += `   **Error:** ${r.error}\n\n`;
    });
  }

  if (successful > 0) {
    response += `## Successful Commands\n\n`;
    results.filter(r => r.success).forEach((r) => {
      response += `${r.step}. **${r.tool}** ✓\n`;
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

  let response = `# Sequence Paused: ${sequence.name}\n\n`;
  response += `**Paused after step ${pausedAtStep} of ${commands.length}**\n\n`;
  response += `**Executed:** ${successful} commands in ${(durationMs / 1000).toFixed(1)}s\n`;
  response += `**Remaining:** ${commands.length - pausedAtStep} commands\n\n`;

  response += `## Completed Steps\n\n`;
  results.forEach((r) => {
    response += `${r.step}. **${r.tool}** ✓\n`;
  });

  response += `\n## Next Steps\n\n`;
  for (let j = pausedAtStep; j < Math.min(pausedAtStep + 3, commands.length); j++) {
    response += `${j + 1}. **${commands[j].tool}**\n`;
  }
  if (commands.length > pausedAtStep + 3) {
    response += `... and ${commands.length - pausedAtStep - 3} more\n`;
  }

  response += `\n## Actions\n\n`;
  response += `- Continue: \`replay({ action: 'step' })\` or \`replay({ action: 'step', stepCount: N })\`\n`;
  response += `- Finish all: \`replay({ action: 'finish' })\`\n`;
  response += `- Check status: \`replay({ action: 'status' })\`\n`;
  response += `- Insert commands: \`replay({ action: 'insert' })\`\n`;

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
  let response = `# Breakpoint Hit: ${sequenceName}\n\n`;
  response += `**Paused at breakpoint** after step ${results.length} of ${totalCommands}\n\n`;
  response += `**Location:** \`${breakpointInfo.url}:${breakpointInfo.lineNumber}\`\n`;
  if (breakpointInfo.functionName) {
    response += `**Function:** \`${breakpointInfo.functionName}\`\n`;
  }
  response += `**Duration:** ${(durationMs / 1000).toFixed(1)}s\n\n`;

  response += `## Completed Steps\n\n`;
  results.forEach((r) => {
    response += `${r.step}. **${r.tool}** ✓\n`;
  });

  response += `\n## Debug Actions\n\n`;
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

  let section = `\n## Debug State\n\n`;

  if (debugState.isPaused) {
    section += `**Execution paused** at ${debugState.pauseLocation}\n\n`;
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
  let response = `**Loaded:** ${sequenceName}\n\n`;
  response += `**Found ${Object.keys(variables).length} customizable text parameter(s):**\n\n`;

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

/**
 * Format dry run preview
 */
export function formatDryRunPreview(sequenceName: string, commands: RecordedCommand[]): string {
  let response = `# Replay Preview: ${sequenceName}\n\n`;
  response += `**Would execute ${commands.length} command(s):**\n\n`;
  commands.forEach((cmd, idx) => {
    response += `${idx + 1}. **${cmd.tool}**\n`;
    response += `\`\`\`json\n${JSON.stringify(cmd.params, null, 2)}\n\`\`\`\n\n`;
  });
  response += `**To execute:** Remove \`dryRun: true\` and provide \`connectionReason\` parameter`;
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
    return `# Command History\n\n` +
      `No commands recorded yet.\n\n` +
      `**Note:** All tool calls are automatically recorded. Execute some commands to see them here.`;
  }

  let response = `# Command History (${history.length} of ${totalCount})\n\n`;

  history.forEach((cmd) => {
    const paramStr = JSON.stringify(cmd.params);
    const truncatedParams = paramStr.length > 60 ? paramStr.slice(0, 60) + '...' : paramStr;
    response += `${cmd.index}. **${cmd.tool}** - ${truncatedParams}\n`;
  });

  response += `\n---\n`;
  response += `Create sequence: \`replay({ action: 'create', name: '...', indices: [${history.slice(0, 3).map(c => c.index).join(', ')}] })\``;

  return response;
}

/**
 * Format sequence created response
 */
export function formatSequenceCreated(sequence: CommandSequence): string {
  let response = `# Sequence Created: ${sequence.name}\n\n`;
  response += `**Sequence ID:** \`${sequence.id}\`\n`;
  if (sequence.description) {
    response += `**Description:** ${sequence.description}\n`;
  }
  if (sequence.expectedOutcome) {
    response += `**Expected Outcome:** ${sequence.expectedOutcome}\n`;
  }
  if (sequence.startUrl) {
    response += `**Start URL:** ${sequence.startUrl}\n`;
  }
  response += `**Commands:** ${sequence.commands.length}\n\n`;
  response += `## Commands in Sequence\n\n`;

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
    return `# Saved Sequences\n\nNo sequences saved yet.\n\n` +
      `**Create a sequence:**\n` +
      `1. View command history: \`replay({ action: 'history' })\`\n` +
      `2. Create sequence: \`replay({ action: 'create', name: 'my-workflow', indices: [1, 2, 3] })\``;
  }

  let response = `# Saved Sequences (${sequences.length})\n\n`;
  sequences.forEach((seq, idx) => {
    const age = Math.floor((Date.now() - seq.createdAt) / 1000 / 60);
    response += `## ${idx + 1}. ${seq.name}\n`;
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
    response += `- **Created:** ${age} minutes ago\n\n`;
  });

  response += `---\n\n`;
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
  let response = `# Sequence: ${sequence.name}\n\n`;
  response += `**ID:** \`${sequence.id}\`\n`;
  if (sequence.description) {
    response += `**Description:** ${sequence.description}\n`;
  }
  if (sequence.expectedOutcome) {
    response += `**Expected Outcome:** ${sequence.expectedOutcome}\n`;
  }
  if (sequence.startUrl) {
    response += `**Start URL:** ${sequence.startUrl}\n`;
  }
  response += `**Commands:** ${sequence.commands.length}\n`;
  response += `**Created:** ${new Date(sequence.createdAt).toLocaleString()}\n\n`;
  response += `## Commands\n\n`;

  sequence.commands.forEach((cmd: RecordedCommand, idx: number) => {
    response += `### ${idx + 1}. ${cmd.tool}\n`;
    response += `**Parameters:**\n\`\`\`json\n${JSON.stringify(cmd.params, null, 2)}\n\`\`\`\n\n`;
  });

  response += `---\n\n`;
  response += `**Run Options:**\n`;
  response += `- Execute: \`replay({ action: 'run', sequenceId: '${sequence.id}' })\`\n`;
  response += `- Dry run: \`replay({ action: 'run', sequenceId: '${sequence.id}', dryRun: true })\``;

  return response;
}

/**
 * Format saved sequences on disk listing
 */
export function formatSavedSequencesList(
  sequences: Array<{ filename: string; name: string; id: string; commandCount: number; description?: string; expectedOutcome?: string; startUrl?: string }>
): string {
  if (sequences.length === 0) {
    return `# Saved Sequences on Disk\n\n` +
      `No sequences saved to disk yet.\n\n` +
      `**Save a sequence:**\n` +
      `1. Create or select a sequence\n` +
      `2. Save it: \`replay({ action: 'save', sequenceId: 'seq-id' })\`\n\n` +
      `**Location:** \`.claude/sequences/\``;
  }

  // Sort by ID timestamp (oldest first) - ID format is "seq-{timestamp}"
  const sorted = [...sequences].sort((a, b) => {
    const tsA = parseInt(a.id.replace('seq-', ''), 10) || 0;
    const tsB = parseInt(b.id.replace('seq-', ''), 10) || 0;
    return tsA - tsB;
  });

  let response = `# Saved Sequences (${sorted.length})\n\n`;

  sorted.forEach((seq, idx) => {
    response += `${idx + 1}. ${seq.name} (${seq.commandCount})\n`;
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

  let response = `# Active Sequence: ${activeSeq.sequenceName}\n\n`;
  response += `**Paused at step ${activeSeq.currentStep} of ${activeSeq.totalSteps}**\n`;
  response += `**Connection:** ${activeSeq.connectionReason || 'none'}\n`;
  response += `**Paused for:** ${pausedDuration}s\n\n`;

  if (commandsSincePause.length > 0) {
    response += `## Commands Since Pause (${commandsSincePause.length})\n\n`;
    commandsSincePause.forEach((cmd, idx) => {
      response += `${idx + 1}. [#${cmd.index}] **${cmd.tool}**\n`;
    });
    response += `\n`;
  }

  response += `## Actions\n\n`;
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
  let response = `# Step Results: ${sequenceName}\n\n`;

  if (failed) {
    const failedResult = results.find(r => !r.success)!;
    response += `**Failed at step ${failedResult.step}:** ${failedResult.tool}\n`;
    response += `**Error:** ${failedResult.error}\n\n`;
    response += `Sequence cancelled due to error.`;
  } else {
    const lastExecuted = results.length > 0 ? results[results.length - 1].step : startStep;

    if (lastExecuted >= totalCommands) {
      response += `**Sequence complete!** All ${totalCommands} steps executed.\n`;
    } else {
      response += `**Executed steps ${startStep + 1}-${lastExecuted} of ${totalCommands}**\n\n`;
      results.forEach(r => {
        response += `${r.step}. **${r.tool}** ✓\n`;
      });
      response += `\n**Remaining:** ${totalCommands - lastExecuted} commands\n`;
      response += `\n## Actions\n`;
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
    return `**No commands recorded since pause.**\n\nRun some commands first, then use insert to add them to the sequence.`;
  }

  let response = `# Insert Commands into: ${sequenceName}\n\n`;
  response += `**Commands recorded since pause:**\n\n`;

  commandsSincePause.forEach((cmd) => {
    response += `- [#${cmd.index}] **${cmd.tool}**`;
    if (cmd.params && Object.keys(cmd.params).length > 0) {
      const paramStr = JSON.stringify(cmd.params);
      response += ` - ${paramStr.length > 50 ? paramStr.slice(0, 50) + '...' : paramStr}`;
    }
    response += `\n`;
  });

  response += `\n**Current position:** After step ${currentStep} of ${totalSteps}\n\n`;

  response += `## Insert Options\n\n`;
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
  if (isOverwrite) {
    let response = `# Sequence Updated: ${sequenceName}\n\n`;
    response += `**Inserted ${insertedCount} command(s) after step ${insertAfter}**\n\n`;
    response += `**New total:** ${newTotal} commands\n\n`;
    response += `Save to disk: \`replay({ action: 'save', sequenceId: '${sequenceId}' })\``;
    return response;
  } else {
    let response = `# New Sequence Created: ${sequenceName}\n\n`;
    response += `**Inserted ${insertedCount} command(s) after step ${insertAfter}**\n\n`;
    response += `**Total commands:** ${newTotal}\n\n`;
    response += `Save to disk: \`replay({ action: 'save', sequenceId: '${sequenceId}' })\``;
    return response;
  }
}
