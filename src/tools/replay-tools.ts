/**
 * Command Replay Tools
 */

import { z } from 'zod';
import type { CommandRecorder, RecordedCommand } from '../command-recorder.js';
import { createTool } from '../validation-helpers.js';
import { debugLog } from '../debug-logger.js';
import { createSuccessResponse, createErrorResponse } from '../messages.js';

const replaySchema = z.object({
  action: z.enum(['history', 'create', 'list', 'get', 'delete', 'replay', 'save', 'load', 'listSaved', 'deleteSaved']).describe(
    'Replay action: history (view command history), create (create sequence from indices), list (list in-memory sequences), get (get sequence details), delete (delete from memory), replay (execute sequence), save (save to disk), load (load from disk), listSaved (list saved files), deleteSaved (delete saved file)'
  ),

  // history parameters
  limit: z.number().optional().describe('Number of recent commands to show (for history action, default: 50)'),

  // create parameters
  name: z.string().optional().describe('Name for the sequence (for create action)'),
  description: z.string().optional().describe('Description of what the sequence does (for create action)'),
  expectedOutcome: z.string().optional().describe('Expected outcome when the sequence runs successfully (for create action)'),
  indices: z.array(z.number()).optional().describe('Command indices to include in sequence (for create action)'),

  // get/delete/replay/save parameters
  sequenceId: z.string().optional().describe('Sequence ID (for get, delete, replay, save actions)'),

  // load/deleteSaved parameters
  filename: z.string().optional().describe('Filename (for load, deleteSaved actions)'),
  intoHistory: z.boolean().optional().describe('Load sequence commands into history without executing (for load action, default: false)'),

  // replay parameters
  dryRun: z.boolean().optional().describe('Preview replay without executing (for replay action, default: false)'),
  connectionReason: z.string().optional().describe('Connection reference to use for all commands in replay'),
  record: z.boolean().optional().describe('Record replayed commands into current recording session (for replay action, default: false)'),
  variables: z.record(z.string()).optional().describe('Variable substitutions for text parameters (for replay action). Keys are variable names, values are replacement text. Empty object means keep original values.'),
  stepTimeout: z.number().optional().describe('Timeout in milliseconds for each step (for replay action, default: 30000)'),
  totalTimeout: z.number().optional().describe('Total timeout in milliseconds for entire replay (for replay action, default: 300000)'),
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

            const sequence = await commandRecorder.createSequence(args.name, args.indices, {
              description: args.description,
              expectedOutcome: args.expectedOutcome,
            });

            if (!sequence) {
              return createErrorResponse('INVALID_INDICES', {
                message: 'One or more command indices are invalid. Use replay({ action: "history" }) to see available commands.'
              });
            }

            let response = `# Sequence Created: ${sequence.name}\n\n`;
            response += `**Sequence ID:** \`${sequence.id}\`\n`;
            if (sequence.description) {
              response += `**Description:** ${sequence.description}\n`;
            }
            if (sequence.expectedOutcome) {
              response += `**Expected Outcome:** ${sequence.expectedOutcome}\n`;
            }
            response += `**Commands:** ${sequence.commands.length}\n\n`;
            response += `## Commands in Sequence\n\n`;

            sequence.commands.forEach((cmd, idx) => {
              response += `${idx + 1}. **${cmd.tool}**\n`;
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
              if (seq.description) {
                response += `- **Description:** ${seq.description}\n`;
              }
              if (seq.expectedOutcome) {
                response += `- **Expected Outcome:** ${seq.expectedOutcome}\n`;
              }
              response += `- **Commands:** ${seq.commands.length}\n`;
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

            const sequence = commandRecorder.getSequence(args.sequenceId);

            if (!sequence) {
              return createErrorResponse('SEQUENCE_NOT_FOUND', {
                sequenceId: args.sequenceId,
                message: `Sequence "${args.sequenceId}" not found. Use replay({ action: 'list' }) to see available sequences or replay({ action: 'load', filename: 'filename.json' }) to load a sequence from disk.`
              });
            }

            let response = `# Sequence: ${sequence.name}\n\n`;
            response += `**ID:** \`${sequence.id}\`\n`;
            if (sequence.description) {
              response += `**Description:** ${sequence.description}\n`;
            }
            if (sequence.expectedOutcome) {
              response += `**Expected Outcome:** ${sequence.expectedOutcome}\n`;
            }
            response += `**Commands:** ${sequence.commands.length}\n`;
            response += `**Created:** ${new Date(sequence.createdAt).toLocaleString()}\n\n`;
            response += `## Commands\n\n`;

            sequence.commands.forEach((cmd: RecordedCommand, idx: number) => {
              response += `### ${idx + 1}. ${cmd.tool}\n`;
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

            const sequence = commandRecorder.getSequence(args.sequenceId);

            if (!sequence) {
              return createErrorResponse('SEQUENCE_NOT_FOUND', {
                sequenceId: args.sequenceId,
                message: `Sequence "${args.sequenceId}" not found.`
              });
            }

            const commands = sequence.commands;

            // Check if sequence contains launchChrome before any tools that need a connection
            const toolsNeedingConnection = ['navigate', 'content', 'input', 'console', 'network', 'dom', 'screenshot', 'storage'];
            let launchChromeIndex = -1;
            let firstConnectionToolIndex = -1;

            for (let i = 0; i < commands.length; i++) {
              if (commands[i].tool === 'launchChrome' && launchChromeIndex === -1) {
                launchChromeIndex = i;
              }
              if (toolsNeedingConnection.includes(commands[i].tool) && firstConnectionToolIndex === -1) {
                firstConnectionToolIndex = i;
              }
            }

            // launchChrome is valid if it appears before any tool that needs a connection
            const hasLaunchBeforeConnection = launchChromeIndex !== -1 &&
              (firstConnectionToolIndex === -1 || launchChromeIndex < firstConnectionToolIndex);

            let connectionReasonToUse = args.connectionReason;

            if (hasLaunchBeforeConnection && !connectionReasonToUse) {
              // Extract reference from launchChrome command to use as connectionReason
              const launchParams = commands[launchChromeIndex].params;
              if (launchParams.reference) {
                connectionReasonToUse = launchParams.reference;
                await debugLog('replay', `Using reference from launchChrome at index ${launchChromeIndex}: ${connectionReasonToUse}`);
              }
            }

            if (!connectionReasonToUse && !args.dryRun && !hasLaunchBeforeConnection) {
              return createErrorResponse('MISSING_PARAMETER', {
                action: 'replay',
                missing: 'connectionReason',
                message: 'The "replay" action requires a "connectionReason" parameter (unless doing a dry run or sequence starts with launchChrome)'
              });
            }

            // Extract text variables from sequence
            const extractedVariables: Record<string, { value: string; locations: string[] }> = {};
            commands.forEach((cmd, cmdIdx) => {
              if (cmd.tool === 'input' && cmd.params.action === 'type' && cmd.params.text) {
                const varName = `var_${cmdIdx}_${cmd.params.selector?.replace(/[^a-zA-Z0-9]/g, '_') || 'text'}`;
                if (!extractedVariables[varName]) {
                  extractedVariables[varName] = {
                    value: cmd.params.text,
                    locations: []
                  };
                }
                extractedVariables[varName].locations.push(`Command ${cmdIdx + 1}: ${cmd.tool} -> ${cmd.params.selector}`);
              }
            });

            // If variables exist and none provided, show them and prompt for values
            if (Object.keys(extractedVariables).length > 0 && args.variables === undefined && !args.dryRun) {
              let response = `**Found ${Object.keys(extractedVariables).length} customizable text parameter(s):**\n\n`;

              Object.entries(extractedVariables).forEach(([varName, data]) => {
                response += `- \`${varName}\`: "${data.value}"\n`;
              });

              response += `\n**Execute:**\n\n`;
              response += `**Option 1: Keep original values**\n`;
              response += `\`\`\`javascript\n`;
              response += `replay({ action: 'replay', sequenceId: '${sequence.id}'`;
              if (connectionReasonToUse) {
                response += `, connectionReason: '${connectionReasonToUse}'`;
              }
              response += `, variables: {} })\n`;
              response += `\`\`\`\n\n`;

              response += `**Option 2: Custom values** (replace variable values as needed)\n`;
              response += `\`\`\`javascript\n`;
              response += `replay({ action: 'replay', sequenceId: '${sequence.id}'`;
              if (connectionReasonToUse) {
                response += `, connectionReason: '${connectionReasonToUse}'`;
              }
              response += `, variables: {\n`;
              Object.keys(extractedVariables).forEach((varName, idx, arr) => {
                response += `  "${varName}": "custom-value"${idx < arr.length - 1 ? ',' : ''}\n`;
              });
              response += `} })\n`;
              response += `\`\`\``;

              return {
                content: [{ type: 'text', text: response }]
              };
            }

            // Dry run - just show what would be executed
            if (args.dryRun) {
              let response = `# Replay Preview: ${sequence.name}\n\n`;
              response += `**Would execute ${commands.length} command(s):**\n\n`;
              commands.forEach((cmd, idx) => {
                response += `${idx + 1}. **${cmd.tool}**\n`;
                response += `\`\`\`json\n${JSON.stringify(cmd.params, null, 2)}\n\`\`\`\n\n`;
              });
              response += `**To execute:** Remove \`dryRun: true\` and provide \`connectionReason\` parameter`;

              return {
                content: [{ type: 'text', text: response }]
              };
            }

            // Check if commands need connectionReason and validate
            const needsConnection = commands.some(cmd =>
              toolsNeedingConnection.includes(cmd.tool) &&
              !cmd.params.connectionReason
            );

            // If connectionReason provided, auto-launch Chrome if not connected (skip if sequence has launchChrome)
            if (connectionReasonToUse && needsConnection && !hasLaunchBeforeConnection) {
              try {
                await debugLog('replay', `Checking connection: ${connectionReasonToUse}`);
                // Try to use the connection - if it fails, we'll launch Chrome
                await executeToolCall('navigate', { action: 'info', connectionReason: connectionReasonToUse });
                await debugLog('replay', `Connection ${connectionReasonToUse} is active`);
              } catch (error) {
                await debugLog('replay', `Connection ${connectionReasonToUse} not active, launching Chrome...`);
                try {
                  await executeToolCall('launchChrome', { reference: connectionReasonToUse });
                  await debugLog('replay', `Chrome launched with reference: ${connectionReasonToUse}`);
                } catch (launchError: any) {
                  return createErrorResponse('LAUNCH_FAILED', {
                    message: `Failed to auto-launch Chrome for replay: ${launchError.message}`,
                    suggestion: 'Launch Chrome manually first'
                  });
                }
              }
            }

            // Execute commands sequentially with validation
            const results: Array<{ command: RecordedCommand; success: boolean; result?: any; error?: string }> = [];

            // Timeout configuration
            const stepTimeout = args.stepTimeout || 30000; // 30 seconds per step default
            const totalTimeout = args.totalTimeout || 300000; // 5 minutes total default
            const replayStartTime = Date.now();

            // Helper to execute with timeout
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

            for (let i = 0; i < commands.length; i++) {
              const cmd = commands[i];

              // Check total timeout
              const elapsed = Date.now() - replayStartTime;
              if (elapsed >= totalTimeout) {
                await debugLog('replay', `Total timeout exceeded after ${elapsed}ms (limit: ${totalTimeout}ms)`);
                results.push({
                  command: cmd,
                  success: false,
                  error: `Total replay timeout exceeded (${totalTimeout}ms). Elapsed: ${elapsed}ms`
                });
                break;
              }

              // Calculate remaining time for this step (minimum of step timeout and remaining total time)
              const remainingTotal = totalTimeout - elapsed;
              const effectiveStepTimeout = Math.min(stepTimeout, remainingTotal);

              try {
                await debugLog('replay', `Executing step ${i + 1}/${commands.length}: ${cmd.tool} (timeout: ${effectiveStepTimeout}ms)`);

                // Start with command params
                let params = { ...cmd.params };

                // Apply variable substitutions if provided
                if (args.variables && cmd.tool === 'input' && params.action === 'type' && params.text) {
                  const varName = `var_${i}_${params.selector?.replace(/[^a-zA-Z0-9]/g, '_') || 'text'}`;
                  if (args.variables[varName] !== undefined) {
                    params.text = args.variables[varName];
                    await debugLog('replay', `Substituted ${varName}: "${params.text}"`);
                  }
                }

                // Insert connectionReason only for tools that need it (not connection management tools)
                if (connectionReasonToUse && toolsNeedingConnection.includes(cmd.tool) && !cmd.params.connectionReason) {
                  params.connectionReason = connectionReasonToUse;
                  await debugLog('replay', `Injecting connectionReason: ${connectionReasonToUse}`);
                }

                // Debug-aware: Replace stale callFrameId with fresh one from current call stack
                if (cmd.tool === 'inspect' && params.action === 'getVariables' && params.callFrameId && connectionReasonToUse) {
                  await debugLog('replay', `getVariables detected with recorded callFrameId: ${params.callFrameId}`);
                  try {
                    // Get fresh call stack
                    const callStackResult = await executeToolCall('inspect', {
                      action: 'getCallStack',
                      connectionReason: connectionReasonToUse
                    });

                    // Parse call stack from markdown response to extract first callFrameId
                    const callStackText = callStackResult?.content?.[0]?.text || '';
                    const callFrameIdMatch = callStackText.match(/"callFrameId":\s*"([^"]+)"/);

                    if (callFrameIdMatch && callFrameIdMatch[1]) {
                      const freshCallFrameId = callFrameIdMatch[1];
                      await debugLog('replay', `Replacing stale callFrameId with fresh: ${freshCallFrameId}`);
                      params.callFrameId = freshCallFrameId;
                    } else {
                      await debugLog('replay', `Warning: Could not extract fresh callFrameId from call stack`);
                    }
                  } catch (err: any) {
                    await debugLog('replay', `Warning: Failed to get fresh callFrameId: ${err.message}`);
                  }
                }

                await debugLog('replay', `Calling ${cmd.tool} with params: ${JSON.stringify(params)}`);
                let result;
                try {
                  result = await executeWithTimeout(
                    executeToolCall(cmd.tool, params),
                    effectiveStepTimeout,
                    `Step ${i + 1} (${cmd.tool}) timed out after ${effectiveStepTimeout}ms`
                  );
                } catch (execError: any) {
                  await debugLog('replay', `FATAL: executeToolCall threw: ${execError.message}\n${execError.stack}`);
                  throw execError;
                }

                // Check if command completed successfully before continuing
                if (result && result.isError) {
                  // Gather diagnostic information instead of generic suggestions
                  let diagnostics = '';
                  try {
                    if (connectionReasonToUse) {
                      // Get console errors/warnings count
                      const consoleResult = await executeToolCall('console', {
                        action: 'list',
                        type: 'error',
                        connectionReason: connectionReasonToUse
                      });
                      const consoleText = consoleResult?.content?.[0]?.text || '';
                      const errorCount = (consoleText.match(/\*\*error\*\*/gi) || []).length;

                      // Get failed network requests
                      const networkResult = await executeToolCall('network', {
                        action: 'search',
                        statusCode: '4',
                        connectionReason: connectionReasonToUse
                      });
                      const networkText = networkResult?.content?.[0]?.text || '';
                      const failedRequests = (networkText.match(/\d{3}/g) || []).filter((s: string) => s.startsWith('4') || s.startsWith('5')).length;

                      // Get clickable elements count
                      const clickableResult = await executeToolCall('content', {
                        action: 'findClickable',
                        connectionReason: connectionReasonToUse
                      });
                      const clickableText = clickableResult?.content?.[0]?.text || '';
                      const clickableMatch = clickableText.match(/Found (\d+)/);
                      const clickableCount = clickableMatch ? clickableMatch[1] : 'unknown';

                      diagnostics = ` | Page state: ${clickableCount} clickable elements, ${errorCount} console errors, ${failedRequests} failed requests`;
                    }
                  } catch (diagError) {
                    // Don't let diagnostic gathering break the error flow
                    diagnostics = '';
                  }

                  // Extract just the error message from the result
                  const errorText = result.content?.[0]?.text || 'Unknown error';
                  const cleanError = errorText.split('\n')[0]; // First line only
                  throw new Error(`${cleanError}${diagnostics}`);
                }

                // Record command if record option is enabled (for building new sequences from replays)
                if (args.record) {
                  commandRecorder.recordCommand(cmd.tool, params);
                  await debugLog('replay', `Recorded: ${cmd.tool}`);
                }

                results.push({ command: cmd, success: true, result });
                await debugLog('replay', `Step ${i + 1} completed successfully`);

                // Debug-aware: Wait for debugger pause after navigation if breakpoints exist
                if (cmd.tool === 'navigate' && connectionReasonToUse) {
                  try {
                    // Check if there are active breakpoints
                    const breakpointResult = await executeToolCall('breakpoint', {
                      action: 'list',
                      connectionReason: connectionReasonToUse
                    });

                    const breakpointText = breakpointResult?.content?.[0]?.text || '';
                    // Check if there are any breakpoints (look for breakpoint IDs in the output)
                    const hasBreakpoints = breakpointText.includes('**ID:**') || breakpointText.includes('breakpointId');

                    if (hasBreakpoints) {
                      await debugLog('replay', `Navigation completed with active breakpoints, waiting for debugger pause...`);

                      // Wait for debugger to pause (with timeout based on step timeout)
                      const pauseTimeout = Math.min(effectiveStepTimeout, 10000); // Max 10s wait for pause
                      const pauseStartTime = Date.now();
                      let isPaused = false;

                      while (Date.now() - pauseStartTime < pauseTimeout) {
                        // Check if debugger is paused by trying to get call stack
                        const callStackResult = await executeToolCall('inspect', {
                          action: 'getCallStack',
                          connectionReason: connectionReasonToUse
                        });

                        const callStackText = callStackResult?.content?.[0]?.text || '';
                        // If we get a call stack with frames, we're paused
                        if (callStackText.includes('callFrameId') && !callStackText.includes('Not paused')) {
                          isPaused = true;
                          await debugLog('replay', `Debugger paused at breakpoint`);
                          break;
                        }

                        // Wait a bit before checking again
                        await new Promise(resolve => setTimeout(resolve, 100));
                      }

                      if (!isPaused) {
                        await debugLog('replay', `Warning: Debugger did not pause within ${pauseTimeout}ms (breakpoint may not have been hit)`);
                      }
                    }
                  } catch (err: any) {
                    await debugLog('replay', `Warning: Could not check for debugger pause: ${err.message}`);
                  }
                }

                // Auto-validate after type action: verify text was entered
                if (cmd.tool === 'input' && params.action === 'type' && params.selector && connectionReasonToUse) {
                  const expectedText = params.text || '';
                  const selector = params.selector;
                  await debugLog('replay', `Validating typed text in ${selector}`);

                  try {
                    // Wait briefly for value to settle
                    await new Promise(resolve => setTimeout(resolve, 100));

                    // Get the actual value from the input using DOM query
                    const valueResult = await executeToolCall('dom', {
                      action: 'querySelector',
                      selector: selector,
                      connectionReason: connectionReasonToUse
                    });

                    // Extract the actual value from the querySelector result
                    // The result contains element info including value for inputs
                    let actualValue = '';
                    if (valueResult?.content?.[0]?.text) {
                      const text = valueResult.content[0].text;
                      // Look for value in the response - querySelector returns element properties
                      const valueMatch = text.match(/\*\*Value:\*\*\s*`([^`]*)`/);
                      if (valueMatch) {
                        actualValue = valueMatch[1];
                      } else {
                        // Fallback: use evaluateExpression and parse markdown result
                        const evalResult = await executeToolCall('inspect', {
                          action: 'evaluateExpression',
                          expression: `document.querySelector('${selector.replace(/'/g, "\\'")}')?.value || ''`,
                          connectionReason: connectionReasonToUse
                        });
                        if (evalResult?.content?.[0]?.text) {
                          // Parse the markdown response - result is in code block
                          const codeBlockMatch = evalResult.content[0].text.match(/```(?:json)?\n([\s\S]*?)\n```/);
                          if (codeBlockMatch) {
                            actualValue = codeBlockMatch[1].trim();
                            // Remove quotes if it's a JSON string
                            if (actualValue.startsWith('"') && actualValue.endsWith('"')) {
                              actualValue = JSON.parse(actualValue);
                            }
                          }
                        }
                      }
                    }

                    if (actualValue !== expectedText) {
                      await debugLog('replay', `Text validation failed: expected "${expectedText}", got "${actualValue}"`);
                      throw new Error(`Text validation failed for ${selector}: expected "${expectedText}", got "${actualValue}"`);
                    }

                    await debugLog('replay', `Text validated: "${actualValue}" matches expected`);
                  } catch (error: any) {
                    if (error.message?.includes('Text validation failed')) {
                      throw error; // Re-throw validation errors
                    }
                    await debugLog('replay', `Warning: Could not validate typed text: ${error}`);
                  }
                }

                // Auto-validate after navigation or click: check if next element exists
                const isNavigationAction = cmd.tool === 'navigate' ||
                  (cmd.tool === 'input' && params.action === 'click');

                if (isNavigationAction && connectionReasonToUse && i + 1 < commands.length) {
                  const nextCmd = commands[i + 1];

                  // If next command is input with a selector, validate element exists
                  if (nextCmd.tool === 'input' && nextCmd.params.selector) {
                    const selector = nextCmd.params.selector;
                    await debugLog('replay', `Validating next element exists: ${selector}`);

                    try {
                      // Try to query the element with retries
                      let retries = 5;
                      let found = false;

                      while (retries > 0 && !found) {
                        try {
                          const checkResult = await executeToolCall('dom', {
                            action: 'querySelector',
                            selector: selector,
                            connectionReason: connectionReasonToUse
                          });

                          if (checkResult && !checkResult.isError) {
                            found = true;
                            await debugLog('replay', `Element ${selector} found and ready`);
                          } else {
                            // Element not found, decrement retries and wait
                            retries--;
                            if (retries > 0) {
                              await debugLog('replay', `Element ${selector} not found, waiting... (${retries} retries left)`);
                              await new Promise(resolve => setTimeout(resolve, 500));
                            }
                          }
                        } catch (e) {
                          // Exception during query, also decrement retries
                          retries--;
                          if (retries > 0) {
                            await debugLog('replay', `Element query failed, waiting... (${retries} retries left): ${e}`);
                            await new Promise(resolve => setTimeout(resolve, 500));
                          }
                        }
                      }

                      if (!found) {
                        await debugLog('replay', `Warning: Element ${selector} not found after waiting`);
                      }
                    } catch (error) {
                      await debugLog('replay', `Warning: Could not validate element: ${error}`);
                    }
                  }
                }
              } catch (error: any) {
                await debugLog('replay', `Error executing step ${i + 1} ${cmd.tool}: ${error}`);
                results.push({
                  command: cmd,
                  success: false,
                  error: error.message || 'Unknown error'
                });
                // Stop execution on first failure
                await debugLog('replay', `Stopping replay due to error at step ${i + 1}`);
                break;
              }
            }

            await debugLog('replay', `Replay loop completed, building results...`);

            const successful = results.filter(r => r.success).length;
            const failed = results.filter(r => !r.success).length;
            const totalElapsed = Date.now() - replayStartTime;
            const timedOut = results.some(r => r.error?.includes('timed out') || r.error?.includes('timeout exceeded'));

            await debugLog('replay', `Replay finished: ${successful} successful, ${failed} failed, duration: ${(totalElapsed / 1000).toFixed(1)}s`);

            let response = `# Replay Results: ${sequence.name}\n\n`;
            response += `**Executed:** ${results.length} of ${commands.length} commands\n`;
            response += `**Successful:** ${successful}\n`;
            response += `**Failed:** ${failed}\n`;
            response += `**Duration:** ${(totalElapsed / 1000).toFixed(1)}s\n`;
            if (timedOut) {
              response += `**Status:** ⏱️ Timed out\n`;
            }
            if (args.record) {
              response += `**Recorded:** ${successful} commands added to history\n`;
            }
            response += `\n`;

            if (failed > 0) {
              response += `## Failed Commands\n\n`;
              results.filter(r => !r.success).forEach((r) => {
                const cmdNum = results.indexOf(r) + 1;
                response += `${cmdNum}. **${r.command.tool}**\n`;
                response += `   **Error:** ${r.error}\n\n`;
              });
              response += `**Note:** Execution stopped at first failure.\n\n`;
            }

            if (successful > 0) {
              response += `## Successful Commands\n\n`;
              results.filter(r => r.success).forEach((r) => {
                const cmdNum = results.indexOf(r) + 1;
                response += `${cmdNum}. **${r.command.tool}** ✓\n`;
              });
            }

            // Check for active debug session state after replay
            if (connectionReasonToUse && failed === 0) {
              try {
                // Check for active breakpoints
                const breakpointResult = await executeToolCall('breakpoint', {
                  action: 'list',
                  connectionReason: connectionReasonToUse
                });
                const breakpointText = breakpointResult?.content?.[0]?.text || '';

                // Extract breakpoint info - look for Total count or table row IDs
                const totalMatch = breakpointText.match(/\*\*Total:\*\*\s*(\d+)/);
                const breakpointCount = totalMatch ? parseInt(totalMatch[1], 10) : 0;

                // Check if debugger is paused
                const callStackResult = await executeToolCall('inspect', {
                  action: 'getCallStack',
                  connectionReason: connectionReasonToUse
                });
                const callStackText = callStackResult?.content?.[0]?.text || '';
                const isPaused = callStackText.includes('callFrameId') && !callStackText.includes('Not paused');

                // Add debug state section if there's active debug state
                if (breakpointCount > 0 || isPaused) {
                  response += `\n## Debug State\n\n`;

                  if (isPaused) {
                    // Extract pause location
                    const pauseLocationMatch = callStackText.match(/Paused at:\s*([^\n]+)/);
                    const pauseLocation = pauseLocationMatch ? pauseLocationMatch[1] : 'unknown location';
                    response += `⏸️ **Execution paused** at ${pauseLocation}\n\n`;
                    response += `**Next steps:**\n`;
                    response += `- Inspect call stack: \`inspect({ action: 'getCallStack', connectionReason: '${connectionReasonToUse}' })\`\n`;
                    response += `- Get variables: \`inspect({ action: 'getVariables', connectionReason: '${connectionReasonToUse}', callFrameId: '<from call stack>' })\`\n`;
                    response += `- Resume execution: \`execution({ action: 'resume', connectionReason: '${connectionReasonToUse}' })\`\n`;
                    response += `- Step over: \`execution({ action: 'stepOver', connectionReason: '${connectionReasonToUse}' })\`\n`;
                  }

                  if (breakpointCount > 0) {
                    response += `\n🔴 **${breakpointCount} active breakpoint${breakpointCount > 1 ? 's' : ''}**\n`;
                    response += `- List breakpoints: \`breakpoint({ action: 'list', connectionReason: '${connectionReasonToUse}' })\`\n`;
                    response += `- Remove all: \`breakpoint({ action: 'remove', connectionReason: '${connectionReasonToUse}', breakpointId: '<id>' })\`\n`;
                  }
                }
              } catch (err: any) {
                await debugLog('replay', `Could not get debug state: ${err.message}`);
              }
            }

            await debugLog('replay', `Returning replay results (response length: ${response.length} chars)`);
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
              filename: filepath,
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

            // If intoHistory is true, load commands into history without executing
            if (args.intoHistory) {
              let loadedCount = 0;
              for (const cmd of sequence.commands) {
                commandRecorder.recordCommand(cmd.tool, cmd.params);
                loadedCount++;
              }
              await debugLog('replay', `Loaded ${loadedCount} commands from "${sequence.name}" into history`);

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
              response += `   - ID: \`${seq.id}\`\n`;
              if (seq.description) {
                response += `   - Description: ${seq.description}\n`;
              }
              if (seq.expectedOutcome) {
                response += `   - Expected Outcome: ${seq.expectedOutcome}\n`;
              }
              response += `\n`;
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
