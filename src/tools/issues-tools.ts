/**
 * Issues Tools
 * MCP tools for tracking bugs and features with persistent CSV storage
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import { join } from 'path';
import { createTool } from '../validation-helpers.js';
import { createSuccessResponse, createErrorResponse } from '../messages.js';
import { showVerificationOverlay, showTestReadyOverlay } from '../interaction-recorder.js';
import {
  showOverlay,
  getWorkOnNoSequenceConfig,
  getTestReadyConfig,
  getVerificationConfig,
  type OverlayResult,
} from '../overlays.js';
import { requireValidReference } from '../reference-validator.js';
import {
  initializeTracker,
  addIssue,
  getIssue,
  getIssues,
  updateIssueStatus,
  updateIssueSequenceFile,
  acknowledgeAllBugs,
  getPendingBugs,
  getInteractionSequencesDir,
  generateSequenceFilename,
  type TrackedIssue,
  type IssueType,
  type IssueStatus,
} from '../issue-tracker.js';
const issuesSchema = z.object({
  action: z.enum(['list', 'create', 'workOn', 'resolve', 'acknowledge'])
    .describe('Issue action: list (list all issues), create (create new issue), workOn (start working on issue), resolve (mark as fixed/implemented), acknowledge (acknowledge pending bugs)'),
  id: z.number().optional()
    .describe('Issue ID (for workOn, resolve actions)'),
  type: z.enum(['bug', 'feature']).optional()
    .describe('Issue type (required for create, optional filter for list)'),
  status: z.enum(['pending', 'acknowledged', 'in_progress', 'fixed', 'implemented']).optional()
    .describe('Issue status (optional filter for list)'),
  description: z.string().optional()
    .describe('Issue description (required for create)'),
  sequenceName: z.string().optional()
    .describe('Name of existing sequence to link (for create - moves sequence to interactions folder)'),
  startUrl: z.string().optional()
    .describe('Starting URL for manual issue verification (required for create when no sequenceName provided)'),
  connectionReason: z.string().optional()
    .describe('Browser connection reference (for workOn - to replay sequence)'),
  keepBrowserOpen: z.boolean().optional()
    .describe('Keep browser tab open after verification (default: false, closes tab after resolve)'),
  search: z.string().optional()
    .describe('Search term to filter issues by description or recording name (for list)'),
  includeCompleted: z.boolean().optional()
    .describe('Include fixed/implemented issues in list (default: false, only shows active issues)'),
}).strict();

type IssuesArgs = z.infer<typeof issuesSchema>;

// =============================================================================
// Helper Functions
// =============================================================================


function formatIssuesList(issues: TrackedIssue[]): string {
  if (issues.length === 0) {
    return 'No issues found.';
  }

  const lines: string[] = [];

  for (const issue of issues) {
    const date = issue.reportedAt.toLocaleDateString();
    const statusIcon = getStatusIcon(issue.status);
    const typeIcon = issue.type === 'bug' ? '🐛' : '✨';

    lines.push(`${typeIcon} **#${issue.id}** [${statusIcon} ${issue.status}] ${issue.description}`);
    lines.push(`   Reported: ${date} | Recording: ${issue.recordingName || 'none'}`);
    if (issue.sequenceFile) {
      lines.push(`   Sequence: \`${issue.sequenceFile}\``);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function getStatusIcon(status: IssueStatus): string {
  switch (status) {
    case 'pending': return '⏳';
    case 'acknowledged': return '👀';
    case 'in_progress': return '🔧';
    case 'fixed': return '✅';
    case 'implemented': return '✅';
    default: return '•';
  }
}

function formatIssueDetails(issue: TrackedIssue): string {
  const typeIcon = issue.type === 'bug' ? '🐛' : '✨';
  const statusIcon = getStatusIcon(issue.status);

  const lines = [
    `${typeIcon} **Issue #${issue.id}** - ${issue.type.toUpperCase()}`,
    `**Status:** ${statusIcon} ${issue.status}`,
    `**Description:** ${issue.description}`,
    `**Recording:** ${issue.recordingName || 'none'}`,
    `**Reported:** ${issue.reportedAt.toISOString()}`,
  ];

  if (issue.sequenceFile) {
    lines.push(`**Sequence:** \`${issue.sequenceFile}\``);
  }

  if (issue.acknowledgedAt) {
    lines.push(`**Acknowledged:** ${issue.acknowledgedAt.toISOString()}`);
  }

  if (issue.startedAt) {
    lines.push(`**Started:** ${issue.startedAt.toISOString()}`);
  }

  if (issue.resolvedAt) {
    lines.push(`**Resolved:** ${issue.resolvedAt.toISOString()}`);
  }

  return lines.join('\n');
}

// =============================================================================
// Tool Export
// =============================================================================

export function createIssuesTools(
  executeToolCall: (toolName: string, params: Record<string, any>) => Promise<any>,
  getSequencePath?: (name: string) => Promise<string | null>,
  getPageForConnection?: (connectionReason: string) => Promise<any>
) {
  return {
    issues: createTool(
      'Track and manage bugs and features. Actions: list (show all issues with optional filters), create (create new issue, optionally linking a sequence), workOn (start working on issue with auto-replay), resolve (mark as fixed/implemented), acknowledge (acknowledge pending bugs to unblock tools)',
      issuesSchema,
      async (args) => {
        // Initialize tracker on first use
        await initializeTracker();

        switch (args.action) {
          case 'list': {
            const filter: { type?: IssueType; status?: IssueStatus; includeCompleted?: boolean } = {};
            if (args.type) filter.type = args.type;
            if (args.status) filter.status = args.status;
            if (args.includeCompleted) filter.includeCompleted = true;

            let issues = await getIssues(filter);

            // Apply search filter
            if (args.search) {
              const searchLower = args.search.toLowerCase();
              issues = issues.filter(i =>
                i.description.toLowerCase().includes(searchLower) ||
                i.recordingName.toLowerCase().includes(searchLower)
              );
            }

            // Get counts from filtered list
            const bugCount = issues.filter(i => i.type === 'bug').length;
            const featureCount = issues.filter(i => i.type === 'feature').length;
            const pendingCount = issues.filter(i => i.status === 'pending').length;

            return createSuccessResponse('ISSUES_LIST', {
              count: issues.length,
              bugCount,
              featureCount,
              pendingCount,
              issuesList: formatIssuesList(issues),
              search: args.search || null,
              includeCompleted: args.includeCompleted || false,
            });
          }

          case 'create': {
            if (!args.type) {
              return createErrorResponse('ISSUES_MISSING_TYPE', {
                message: 'Issue type is required (bug or feature)',
              });
            }

            if (!args.description) {
              return createErrorResponse('ISSUES_MISSING_DESCRIPTION', {
                message: 'Issue description is required',
              });
            }

            // Require startUrl when no sequence is provided
            if (!args.sequenceName && !args.startUrl) {
              return createErrorResponse('ISSUES_MISSING_START_URL', {
                message: 'startUrl is required when no sequenceName is provided (needed for verification)',
              });
            }

            let sequenceFile = '';

            // If sequenceName provided, move/copy sequence to interactions folder
            if (args.sequenceName && getSequencePath) {
              const sourcePath = await getSequencePath(args.sequenceName);

              if (sourcePath) {
                // Generate new filename for interactions folder
                // We'll use a temporary ID, then update after creating the issue
                const tempId = Date.now();
                const newFilename = generateSequenceFilename(args.type, tempId, args.description);
                const destPath = join(getInteractionSequencesDir(), newFilename);

                try {
                  // Copy the sequence file
                  await fs.copyFile(sourcePath, destPath);
                  sequenceFile = newFilename;
                } catch (error: any) {
                  return createErrorResponse('ISSUES_SEQUENCE_COPY_FAILED', {
                    sequenceName: args.sequenceName,
                    error: error.message,
                  });
                }
              } else {
                return createErrorResponse('ISSUES_SEQUENCE_NOT_FOUND', {
                  sequenceName: args.sequenceName,
                  message: `Sequence "${args.sequenceName}" not found`,
                });
              }
            }

            // Manually created issues start as acknowledged (no blocking)
            const issue = await addIssue(
              args.type,
              args.description,
              sequenceFile,
              args.sequenceName || 'manual',
              'acknowledged',
              args.startUrl || ''
            );

            // If we created a sequence file with temp ID, rename it with real ID
            if (sequenceFile && args.sequenceName) {
              const correctFilename = generateSequenceFilename(args.type, issue.id, args.description);
              if (correctFilename !== sequenceFile) {
                const oldPath = join(getInteractionSequencesDir(), sequenceFile);
                const newPath = join(getInteractionSequencesDir(), correctFilename);
                try {
                  await fs.rename(oldPath, newPath);
                  issue.sequenceFile = correctFilename;
                  // Note: Would need to save again, but for now this is okay
                } catch {
                  // Keep old filename if rename fails
                }
              }
            }

            return createSuccessResponse('ISSUES_CREATED', {
              id: issue.id,
              type: issue.type,
              description: issue.description,
              sequenceFile: issue.sequenceFile || null,
            });
          }

          case 'workOn': {
            if (!args.id) {
              return createErrorResponse('ISSUES_MISSING_ID', {
                message: 'Issue ID is required',
              });
            }

            const issue = await getIssue(args.id);
            if (!issue) {
              return createErrorResponse('ISSUES_NOT_FOUND', {
                id: args.id,
                message: `Issue #${args.id} not found`,
              });
            }

            // Update status to in_progress
            await updateIssueStatus(args.id, 'in_progress');

            // Use provided connectionReason or generate one
            let connectionRef: string | null = null;
            if (args.connectionReason) {
              connectionRef = requireValidReference(args.connectionReason);
            } else {
              connectionRef = `${issue.type} ${issue.id} workOn`;
            }

            const hasSequence = !!issue.sequenceFile;

            if (hasSequence) {
              // Auto-replay sequence if available
              const sequencePath = join(getInteractionSequencesDir(), issue.sequenceFile!);
              const sequenceName = issue.sequenceFile!.replace(/\.json$/, '');

              // Load and run sequence (errors propagate via ToolError)
              await executeToolCall('replay', {
                action: 'load',
                filename: sequencePath,
              });

              await executeToolCall('replay', {
                action: 'run',
                name: sequenceName,
                connectionReason: connectionRef,
                showReplayOverlay: true,
                issueId: issue.id,
                issueType: issue.type,
                issueDescription: issue.description,
              });
            } else if (issue.startUrl && getPageForConnection) {
              // No sequence but has startUrl - launch browser, navigate, and show options overlay
              let page = await getPageForConnection(connectionRef);
              if (!page) {
                // Auto-launch Chrome
                try {
                  await executeToolCall('launchChrome', {
                    reference: connectionRef,
                  });
                  page = await getPageForConnection(connectionRef);
                } catch (error: any) {
                  return createErrorResponse('ISSUES_CHROME_LAUNCH_FAILED', {
                    message: `Failed to launch Chrome: ${error.message}`,
                  });
                }
              }

              if (!page) {
                return createErrorResponse('ISSUES_PAGE_ERROR', {
                  message: 'Failed to get browser page after launch',
                });
              }

              // Navigate to startUrl
              await executeToolCall('navigate', {
                action: 'goto',
                connectionReason: connectionRef,
                url: issue.startUrl,
                waitUntil: 'load',
              });

              // Refresh page reference after navigation
              page = await getPageForConnection(connectionRef);
              if (!page) {
                return createErrorResponse('ISSUES_PAGE_ERROR', {
                  message: 'Lost browser page after navigation',
                });
              }

              // Show overlay with options: Cancel, Explore, or Record
              const overlayConfig = getWorkOnNoSequenceConfig(issue.type, issue.id, issue.description);
              const result = await showOverlay(page, overlayConfig);

              if (result.action === 'cancel') {
                return createSuccessResponse('ISSUES_WORK_CANCELLED', {
                  id: issue.id,
                  type: issue.type,
                  description: issue.description,
                  message: 'Work session cancelled by user',
                });
              }

              if (result.action === 'record') {
                // Start recording user's actions - this blocks until recording completes
                const recordingResult = await executeToolCall('replay', {
                  action: 'recordInteraction',
                  connectionReason: connectionRef,
                  name: `${issue.type}-${issue.id}-repro`,
                  startUrl: issue.startUrl,
                  issueId: issue.id,
                  issueType: issue.type,
                  issueDescription: issue.description,
                });

                // Return the recording result directly so user sees what was recorded
                return recordingResult;
              }

              // action === 'explore' - just leave browser open for manual exploration
            }

            return createSuccessResponse('ISSUES_WORK_STARTED', {
              id: issue.id,
              type: issue.type,
              description: issue.description,
              sequenceFile: issue.sequenceFile || null,
              details: formatIssueDetails(issue),
              replayStarted: hasSequence,
              browserLaunched: !hasSequence && !!issue.startUrl,
              connectionReason: connectionRef,
            });
          }

          case 'resolve': {
            if (!args.id) {
              return createErrorResponse('ISSUES_MISSING_ID', {
                message: 'Issue ID is required',
              });
            }

            if (!getPageForConnection) {
              return createErrorResponse('ISSUES_NO_PAGE_ACCESS', {
                message: 'Cannot access browser page for verification',
              });
            }

            const issue = await getIssue(args.id);
            if (!issue) {
              return createErrorResponse('ISSUES_NOT_FOUND', {
                id: args.id,
                message: `Issue #${args.id} not found`,
              });
            }

            // Generate a unique reference for this resolve session
            const connectionRef = `${issue.type} ${issue.id} resolve`;

            // Always create a fresh tab for resolve verification
            let page = await getPageForConnection(connectionRef);
            if (!page) {
              // Try to create a new tab first (if Chrome is already running)
              try {
                await executeToolCall('tab', {
                  action: 'create',
                  reference: connectionRef,
                });
                page = await getPageForConnection(connectionRef);
              } catch {
                // Chrome not running - launch it
                try {
                  await executeToolCall('launchChrome', {
                    reference: connectionRef,
                  });
                  page = await getPageForConnection(connectionRef);
                } catch (error: any) {
                  return createErrorResponse('ISSUES_CHROME_LAUNCH_FAILED', {
                    message: `Failed to launch Chrome: ${error.message}`,
                  });
                }
              }
            }

            if (!page) {
              return createErrorResponse('ISSUES_PAGE_ERROR', {
                message: 'Failed to get browser page after launch',
              });
            }

            const hasSequence = !!issue.sequenceFile;

            // Navigate to startUrl first (before showing overlay) if no sequence
            if (!hasSequence && issue.startUrl) {
              // executeToolCall throws on error
              await executeToolCall('navigate', {
                action: 'goto',
                connectionReason: connectionRef,
                url: issue.startUrl,
                waitUntil: 'load',
              });

              // Refresh page reference after navigation
              page = await getPageForConnection(connectionRef);
              if (!page) {
                return createErrorResponse('ISSUES_PAGE_ERROR', {
                  message: 'Lost browser page after navigation',
                });
              }
            }

            // Show "Ready to begin?" overlay
            const readyAction = await showTestReadyOverlay(page, issue.type, issue.description, issue.id, hasSequence);

            if (readyAction === 'cancel') {
              return createSuccessResponse('ISSUES_VERIFICATION_CANCELLED', {
                id: issue.id,
                type: issue.type,
                description: issue.description,
                message: 'Verification cancelled by user',
              });
            }

            // Handle re-record: start recording instead of replaying
            if (readyAction === 'rerecord') {
              // Start recording user's actions to replace existing sequence
              // recordInteraction will navigate to startUrl if provided
              const recordingResult = await executeToolCall('replay', {
                action: 'recordInteraction',
                connectionReason: connectionRef,
                name: `${issue.type}-${issue.id}-repro`,
                startUrl: issue.startUrl || 'about:blank',
                issueId: issue.id,
                issueType: issue.type,
                issueDescription: issue.description,
                overwrite: true,
              });

              // Return the recording result directly
              return recordingResult;
            }

            // Play the sequence if available, otherwise record user actions
            if (hasSequence) {
              const sequencePath = join(getInteractionSequencesDir(), issue.sequenceFile!);
              const sequenceName = issue.sequenceFile!.replace(/\.json$/, '');

              // Load and run sequence - executeToolCall throws on error
              await executeToolCall('replay', {
                action: 'load',
                filename: sequencePath,
              });

              await executeToolCall('replay', {
                action: 'run',
                name: sequenceName,
                connectionReason: connectionRef,
                showReplayOverlay: true,
                issueId: issue.id,
                issueType: issue.type,
                issueDescription: issue.description,
              });
            } else {
              // No sequence - start recording user's actions (executeToolCall throws on error)
              await executeToolCall('replay', {
                action: 'recordInteraction',
                connectionReason: connectionRef,
                name: `verify-${issue.type}-${issue.id}`,
                startUrl: issue.startUrl || 'about:blank',
                // Pass issue info so recording saves to interactions folder
                issueId: issue.id,
                issueType: issue.type,
                issueDescription: issue.description,
              });
            }

            // Refresh page reference after replay (in case it changed)
            page = await getPageForConnection(connectionRef);
            if (!page) {
              return createErrorResponse('ISSUES_PAGE_ERROR', {
                message: 'Lost browser page during replay',
              });
            }

            // Show verification overlay and wait for user response
            const verification = await showVerificationOverlay(
              page,
              issue.type,
              issue.description,
              issue.id
            );

            // Close the tab after verification (unless keepBrowserOpen is true)
            if (!args.keepBrowserOpen) {
              try {
                await executeToolCall('tab', {
                  action: 'close',
                  reference: connectionRef,
                });
              } catch (error: any) {
                // Non-fatal - tab close failed but verification completed
              }
            }

            if (verification.resolved) {
              // User confirmed resolution
              const newStatus: IssueStatus = issue.type === 'bug' ? 'fixed' : 'implemented';
              await updateIssueStatus(args.id, newStatus);

              return createSuccessResponse('ISSUES_RESOLVED', {
                id: issue.id,
                type: issue.type,
                status: newStatus,
                description: issue.description,
                userComment: verification.comment || null,
              });
            } else {
              // User said not resolved
              return createSuccessResponse('ISSUES_NOT_RESOLVED', {
                id: issue.id,
                type: issue.type,
                status: issue.status,
                description: issue.description,
                userComment: verification.comment || null,
              });
            }
          }

          case 'acknowledge': {
            const acknowledged = await acknowledgeAllBugs();

            if (acknowledged.length === 0) {
              return createSuccessResponse('ISSUES_NONE_PENDING', {
                message: 'No pending bugs to acknowledge',
              });
            }

            const bugList = acknowledged.map(b => `- #${b.id}: ${b.description}`).join('\n');

            return createSuccessResponse('ISSUES_ACKNOWLEDGED', {
              count: acknowledged.length,
              bugList,
            });
          }

          default: {
            return createErrorResponse('ISSUES_INVALID_ACTION', {
              action: (args as any).action,
              message: `Unknown action: ${(args as any).action}`,
            });
          }
        }
      }
    ),
  };
}
