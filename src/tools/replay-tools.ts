/**
 * Command Replay Tools
 */

import { z } from 'zod';
import type { CommandRecorder, RecordedCommand } from '../command-recorder.js';
import { createTool } from '../validation-helpers.js';
import { createSuccessResponse, createErrorResponse } from '../messages.js';

const replaySchema = z.object({
  action: z.enum(['history', 'create', 'list', 'get', 'delete', 'replay', 'save', 'load', 'listSaved', 'deleteSaved']).describe(
    'Replay action: history (view command history), create (create sequence from indices), list (list in-memory sequences), get (get sequence details), delete (delete from memory), replay (execute sequence), save (save to disk), load (load from disk), listSaved (list saved files), deleteSaved (delete saved file)'
  ),

  // history parameters
  limit: z.number().optional().describe('Number of recent commands to show (for history action, default: 50)'),

  // create parameters
  name: z.string().optional().describe('Name for the sequence (for create action)'),
  indices: z.array(z.number()).optional().describe('Command indices to include in sequence (for create action)'),

  // get/delete/replay/save parameters
  sequenceId: z.string().optional().describe('Sequence ID (for get, delete, replay, save actions)'),

  // load/deleteSaved parameters
  filename: z.string().optional().describe('Filename (for load, deleteSaved actions)'),

  // replay parameters
  dryRun: z.boolean().optional().describe('Preview replay without executing (for replay action, default: false)'),
}).strict();

export function createReplayTools(
  commandRecorder: CommandRecorder,
  executeToolCall: (toolName: string, params: Record<string, any>) => Promise<any>
) {
  return {
    replay: createTool(
      'Record and replay command sequences for testing and automation. Actions: history (view command history), create (create sequence from indices), list (list in-memory sequences), get (get sequence details), delete (delete from memory), replay (execute sequence), save (save sequence to disk), load (load sequence from disk), listSaved (list saved files), deleteSaved (delete saved file)',
      replaySchema,
      async (args) => {
        const { action } = args;

        switch (action) {
          case 'history': {
            const limit = args.limit || 50;
            const history = commandRecorder.getHistory(limit);
            const stats = commandRecorder.getStats();

            if (history.length === 0) {
              return {
                content: [{
                  type: 'text',
                  text: `# Command History\n\n` +
                    `No commands recorded yet.\n\n` +
                    `**Note:** All tool calls are automatically recorded. Execute some commands to see them here.`
                }]
              };
            }

            let response = `# Command History\n\n`;
            response += `**Showing:** Most recent ${history.length} commands\n`;
            response += `**Total in history:** ${stats.historyCount} commands\n`;
            response += `**Range:** #${stats.oldestCommandIndex} to #${stats.newestCommandIndex}\n\n`;
            response += `## Recent Commands\n\n`;

            history.forEach((cmd) => {
              const age = Math.floor((Date.now() - cmd.timestamp) / 1000); // seconds
              const timeStr = age < 60 ? `${age}s ago` : `${Math.floor(age / 60)}m ago`;
              response += `**#${cmd.index}** - ${cmd.tool} (${timeStr})\n`;
              if (cmd.description) {
                response += `   ${cmd.description}\n`;
              }
              response += `\`\`\`json\n${JSON.stringify(cmd.params, null, 2)}\n\`\`\`\n\n`;
            });

            response += `---\n\n`;
            response += `**Create a sequence:**\n`;
            response += `\`\`\`\nreplay({\n  action: 'create',\n  name: 'my-workflow',\n  indices: [${history.slice(0, 3).map(c => c.index).join(', ')}]\n})\n\`\`\``;

            return {
              content: [{ type: 'text', text: response }]
            };
          }

          case 'create': {
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

            const sequence = commandRecorder.createSequence(args.name, args.indices);

            if (!sequence) {
              return createErrorResponse('INVALID_INDICES', {
                message: 'One or more command indices are invalid. Use replay({ action: "history" }) to see available commands.'
              });
            }

            const sequenceWithCommands = commandRecorder.getSequenceWithCommands(sequence.id);
            if (!sequenceWithCommands) {
              return createErrorResponse('SEQUENCE_NOT_FOUND', {
                message: 'Failed to retrieve created sequence'
              });
            }

            let response = `# Sequence Created: ${sequence.name}\n\n`;
            response += `**Sequence ID:** \`${sequence.id}\`\n`;
            response += `**Commands:** ${sequence.commandIndices.length}\n\n`;
            response += `## Commands in Sequence\n\n`;

            sequenceWithCommands.commands.forEach((cmd, idx) => {
              response += `${idx + 1}. **#${cmd.index}** - ${cmd.tool}\n`;
              response += `\`\`\`json\n${JSON.stringify(cmd.params, null, 2)}\n\`\`\`\n\n`;
            });

            response += `---\n\n`;
            response += `**Replay this sequence:**\n`;
            response += `\`replay({ action: 'replay', sequenceId: '${sequence.id}' })\``;

            return {
              content: [{ type: 'text', text: response }]
            };
          }

          case 'list': {
            const sequences = commandRecorder.listSequences();

            if (sequences.length === 0) {
              return {
                content: [{
                  type: 'text',
                  text: `# Saved Sequences\n\nNo sequences saved yet.\n\n` +
                    `**Create a sequence:**\n` +
                    `1. View command history: \`replay({ action: 'history' })\`\n` +
                    `2. Create sequence: \`replay({ action: 'create', name: 'my-workflow', indices: [1, 2, 3] })\``
                }]
              };
            }

            let response = `# Saved Sequences (${sequences.length})\n\n`;
            sequences.forEach((seq, idx) => {
              const age = Math.floor((Date.now() - seq.createdAt) / 1000 / 60); // minutes
              response += `## ${idx + 1}. ${seq.name}\n`;
              response += `- **ID:** \`${seq.id}\`\n`;
              response += `- **Commands:** ${seq.commandIndices.length} (indices: ${seq.commandIndices.join(', ')})\n`;
              response += `- **Created:** ${age} minutes ago\n`;
              response += `- **Actions:** [View](#) | [Replay](#) | [Delete](#)\n\n`;
            });

            response += `---\n\n`;
            response += `**Actions:**\n`;
            response += `- View details: \`replay({ action: 'get', sequenceId: 'seq-id' })\`\n`;
            response += `- Execute: \`replay({ action: 'replay', sequenceId: 'seq-id' })\`\n`;
            response += `- Delete: \`replay({ action: 'delete', sequenceId: 'seq-id' })\``;

            return {
              content: [{ type: 'text', text: response }]
            };
          }

          case 'get': {
            if (!args.sequenceId) {
              return createErrorResponse('MISSING_PARAMETER', {
                action: 'get',
                missing: 'sequenceId',
                message: 'The "get" action requires a "sequenceId" parameter'
              });
            }

            const sequenceWithCommands = commandRecorder.getSequenceWithCommands(args.sequenceId);

            if (!sequenceWithCommands) {
              return createErrorResponse('SEQUENCE_NOT_FOUND', {
                sequenceId: args.sequenceId,
                message: `Sequence "${args.sequenceId}" not found. Use replay({ action: 'list' }) to see available sequences.`
              });
            }

            const { sequence, commands } = sequenceWithCommands;

            let response = `# Sequence: ${sequence.name}\n\n`;
            response += `**ID:** \`${sequence.id}\`\n`;
            response += `**Commands:** ${sequence.commandIndices.length}\n`;
            response += `**Created:** ${new Date(sequence.createdAt).toLocaleString()}\n\n`;
            response += `## Commands\n\n`;

            commands.forEach((cmd, idx) => {
              response += `### ${idx + 1}. #${cmd.index} - ${cmd.tool}\n`;
              response += `**Timestamp:** ${new Date(cmd.timestamp).toLocaleString()}\n`;
              response += `**Parameters:**\n\`\`\`json\n${JSON.stringify(cmd.params, null, 2)}\n\`\`\`\n\n`;
            });

            response += `---\n\n`;
            response += `**Replay Options:**\n`;
            response += `- Execute: \`replay({ action: 'replay', sequenceId: '${sequence.id}' })\`\n`;
            response += `- Dry run: \`replay({ action: 'replay', sequenceId: '${sequence.id}', dryRun: true })\``;

            return {
              content: [{ type: 'text', text: response }]
            };
          }

          case 'delete': {
            if (!args.sequenceId) {
              return createErrorResponse('MISSING_PARAMETER', {
                action: 'delete',
                missing: 'sequenceId',
                message: 'The "delete" action requires a "sequenceId" parameter'
              });
            }

            const deleted = commandRecorder.deleteSequence(args.sequenceId);

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

          case 'replay': {
            if (!args.sequenceId) {
              return createErrorResponse('MISSING_PARAMETER', {
                action: 'replay',
                missing: 'sequenceId',
                message: 'The "replay" action requires a "sequenceId" parameter'
              });
            }

            const sequenceWithCommands = commandRecorder.getSequenceWithCommands(args.sequenceId);

            if (!sequenceWithCommands) {
              return createErrorResponse('SEQUENCE_NOT_FOUND', {
                sequenceId: args.sequenceId,
                message: `Sequence "${args.sequenceId}" not found.`
              });
            }

            const { sequence, commands } = sequenceWithCommands;

            // Dry run - just show what would be executed
            if (args.dryRun) {
              let response = `# Replay Preview: ${sequence.name}\n\n`;
              response += `**Would execute ${commands.length} command(s):**\n\n`;
              commands.forEach((cmd, idx) => {
                response += `${idx + 1}. **#${cmd.index} - ${cmd.tool}**\n`;
                response += `\`\`\`json\n${JSON.stringify(cmd.params, null, 2)}\n\`\`\`\n\n`;
              });
              response += `**To execute:** Remove \`dryRun: true\` parameter`;

              return {
                content: [{ type: 'text', text: response }]
              };
            }

            // Execute commands
            const results: Array<{ command: RecordedCommand; success: boolean; result?: any; error?: string }> = [];

            for (const cmd of commands) {
              try {
                console.error(`[Replay] Executing #${cmd.index}: ${cmd.tool}`);
                const result = await executeToolCall(cmd.tool, cmd.params);
                results.push({ command: cmd, success: true, result });
              } catch (error: any) {
                console.error(`[Replay] Error executing #${cmd.index} ${cmd.tool}:`, error);
                results.push({
                  command: cmd,
                  success: false,
                  error: error.message || 'Unknown error'
                });
              }
            }

            const successful = results.filter(r => r.success).length;
            const failed = results.filter(r => !r.success).length;

            let response = `# Replay Results: ${sequence.name}\n\n`;
            response += `**Executed:** ${commands.length} commands\n`;
            response += `**Successful:** ${successful}\n`;
            response += `**Failed:** ${failed}\n\n`;

            if (failed > 0) {
              response += `## Failed Commands\n\n`;
              results.filter(r => !r.success).forEach((r, idx) => {
                response += `${idx + 1}. **#${r.command.index} - ${r.command.tool}**\n`;
                response += `   **Error:** ${r.error}\n\n`;
              });
            }

            if (successful > 0) {
              response += `## Successful Commands\n\n`;
              results.filter(r => r.success).forEach((r, idx) => {
                response += `${idx + 1}. **#${r.command.index} - ${r.command.tool}** ✓\n`;
              });
            }

            return {
              content: [{ type: 'text', text: response }]
            };
          }

          case 'save': {
            if (!args.sequenceId) {
              return createErrorResponse('MISSING_PARAMETER', {
                action: 'save',
                missing: 'sequenceId',
                message: 'The "save" action requires a "sequenceId" parameter'
              });
            }

            const filepath = await commandRecorder.saveSequenceToDisk(args.sequenceId);

            if (!filepath) {
              return createErrorResponse('SAVE_FAILED', {
                sequenceId: args.sequenceId,
                message: 'Failed to save sequence to disk. Sequence may not exist.'
              });
            }

            return createSuccessResponse('SEQUENCE_SAVED_TO_DISK', {
              sequenceId: args.sequenceId,
              filepath,
              message: `Sequence saved to: ${filepath}`
            });
          }

          case 'load': {
            if (!args.filename) {
              return createErrorResponse('MISSING_PARAMETER', {
                action: 'load',
                missing: 'filename',
                message: 'The "load" action requires a "filename" parameter. Use listSaved to see available files.'
              });
            }

            const sequence = await commandRecorder.loadSequenceFromDisk(args.filename);

            if (!sequence) {
              return createErrorResponse('LOAD_FAILED', {
                filename: args.filename,
                message: 'Failed to load sequence from disk. File may not exist or be invalid.'
              });
            }

            return createSuccessResponse('SEQUENCE_LOADED_FROM_DISK', {
              sequenceId: sequence.id,
              name: sequence.name,
              commandCount: sequence.commandIndices.length,
              message: `Sequence "${sequence.name}" loaded successfully. Use replay({ action: 'replay', sequenceId: '${sequence.id}' }) to execute.`
            });
          }

          case 'listSaved': {
            const savedSequences = await commandRecorder.listSavedSequencesOnDisk();

            if (savedSequences.length === 0) {
              return {
                content: [{
                  type: 'text',
                  text: `# Saved Sequences on Disk\n\n` +
                    `No sequences saved to disk yet.\n\n` +
                    `**Save a sequence:**\n` +
                    `1. Create or select a sequence\n` +
                    `2. Save it: \`replay({ action: 'save', sequenceId: 'seq-id' })\`\n\n` +
                    `**Location:** \`.claude/sequences/\``
                }]
              };
            }

            let response = `# Saved Sequences on Disk (${savedSequences.length})\n\n`;
            response += `**Location:** \`.claude/sequences/\`\n\n`;

            savedSequences.forEach((seq, idx) => {
              response += `${idx + 1}. **${seq.name}**\n`;
              response += `   - Filename: \`${seq.filename}\`\n`;
              response += `   - ID: \`${seq.id}\`\n\n`;
            });

            response += `---\n\n`;
            response += `**Actions:**\n`;
            response += `- Load: \`replay({ action: 'load', filename: 'filename.json' })\`\n`;
            response += `- Delete: \`replay({ action: 'deleteSaved', filename: 'filename.json' })\``;

            return {
              content: [{ type: 'text', text: response }]
            };
          }

          case 'deleteSaved': {
            if (!args.filename) {
              return createErrorResponse('MISSING_PARAMETER', {
                action: 'deleteSaved',
                missing: 'filename',
                message: 'The "deleteSaved" action requires a "filename" parameter'
              });
            }

            const deleted = await commandRecorder.deleteSequenceFromDisk(args.filename);

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

          default:
            return createErrorResponse('INVALID_ACTION', { action });
        }
      }
    ),
  };
}
