/**
 * Issue Tracker - Persistent bug/feature tracking with CSV storage
 */

import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { getOutputPath } from './helpers/paths.js';

// =============================================================================
// Types
// =============================================================================

export type IssueType = 'bug' | 'feature';
export type IssueStatus = 'pending' | 'acknowledged' | 'in_progress' | 'fixed' | 'implemented';

export interface TrackedIssue {
  id: number;
  type: IssueType;
  status: IssueStatus;
  description: string;
  sequenceFile: string;
  startUrl: string;
  reportedAt: Date;
  acknowledgedAt?: Date;
  startedAt?: Date;
  resolvedAt?: Date;
  recordingName: string;
}

export interface IssueFilter {
  type?: IssueType;
  status?: IssueStatus;
  includeCompleted?: boolean;
}

// =============================================================================
// State
// =============================================================================

let issues: TrackedIssue[] = [];
let nextIssueId = 1;
let initialized = false;

// =============================================================================
// File Paths
// =============================================================================

function getInteractionsDir(): string {
  return getOutputPath('interactions');
}

function getSequencesDir(): string {
  return getOutputPath('interactions', 'sequences');
}

function getIssuesFilePath(): string {
  return join(getInteractionsDir(), 'issues.csv');
}

// =============================================================================
// CSV Helpers
// =============================================================================

function escapeCSV(value: string | undefined): string {
  if (value === undefined || value === null) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function parseCSVLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++; // Skip next quote
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        values.push(current);
        current = '';
      } else {
        current += char;
      }
    }
  }
  values.push(current);
  return values;
}

function formatDate(date: Date | undefined): string {
  return date ? date.toISOString() : '';
}

function parseDate(str: string): Date | undefined {
  if (!str) return undefined;
  const date = new Date(str);
  return isNaN(date.getTime()) ? undefined : date;
}

// =============================================================================
// CSV Read/Write
// =============================================================================

const CSV_HEADER = 'id,type,status,description,sequence_file,start_url,reported_at,acknowledged_at,started_at,resolved_at,recording_name';

function issueToCSVRow(issue: TrackedIssue): string {
  return [
    issue.id,
    issue.type,
    issue.status,
    escapeCSV(issue.description),
    escapeCSV(issue.sequenceFile),
    escapeCSV(issue.startUrl),
    formatDate(issue.reportedAt),
    formatDate(issue.acknowledgedAt),
    formatDate(issue.startedAt),
    formatDate(issue.resolvedAt),
    escapeCSV(issue.recordingName)
  ].join(',');
}

function csvRowToIssue(row: string): TrackedIssue | null {
  const values = parseCSVLine(row);
  if (values.length < 11) return null;

  const id = parseInt(values[0], 10);
  if (isNaN(id)) return null;

  return {
    id,
    type: values[1] as IssueType,
    status: values[2] as IssueStatus,
    description: values[3],
    sequenceFile: values[4],
    startUrl: values[5],
    reportedAt: parseDate(values[6]) || new Date(),
    acknowledgedAt: parseDate(values[7]),
    startedAt: parseDate(values[8]),
    resolvedAt: parseDate(values[9]),
    recordingName: values[10]
  };
}

async function loadIssuesFromCSV(includeCompleted: boolean): Promise<void> {
  const filepath = getIssuesFilePath();

  try {
    const content = await fs.readFile(filepath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());

    // Skip header
    if (lines.length > 0 && lines[0].startsWith('id,')) {
      lines.shift();
    }

    issues = [];
    let maxId = 0;

    for (const line of lines) {
      const issue = csvRowToIssue(line);
      if (issue) {
        // Filter out completed issues unless requested
        if (includeCompleted || (issue.status !== 'fixed' && issue.status !== 'implemented')) {
          issues.push(issue);
        }
        if (issue.id > maxId) maxId = issue.id;
      }
    }

    nextIssueId = maxId + 1;
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      // File doesn't exist yet, start fresh
      issues = [];
      nextIssueId = 1;
    } else {
      throw error;
    }
  }
}

async function saveIssuesToCSV(): Promise<void> {
  const filepath = getIssuesFilePath();
  const dir = dirname(filepath);

  // Ensure directory exists
  await fs.mkdir(dir, { recursive: true });

  const lines = [CSV_HEADER, ...issues.map(issueToCSVRow)];
  await fs.writeFile(filepath, lines.join('\n') + '\n', 'utf-8');
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Initialize the issue tracker - loads existing issues from CSV
 * Always reloads from disk to pick up external changes
 */
export async function initializeTracker(includeCompleted: boolean = false): Promise<void> {
  // Ensure directories exist
  await fs.mkdir(getInteractionsDir(), { recursive: true });
  await fs.mkdir(getSequencesDir(), { recursive: true });

  // Always reload from CSV to pick up external changes
  await loadIssuesFromCSV(includeCompleted);
  initialized = true;
}

/**
 * Add a new issue
 */
export async function addIssue(
  type: IssueType,
  description: string,
  sequenceFile: string,
  recordingName: string,
  initialStatus: IssueStatus = 'pending',
  startUrl: string = ''
): Promise<TrackedIssue> {
  await initializeTracker();

  const issue: TrackedIssue = {
    id: nextIssueId++,
    type,
    status: initialStatus,
    description,
    sequenceFile,
    startUrl,
    reportedAt: new Date(),
    recordingName,
    acknowledgedAt: initialStatus === 'acknowledged' ? new Date() : undefined
  };

  issues.push(issue);
  await saveIssuesToCSV();

  return issue;
}

/**
 * Get a single issue by ID
 */
export async function getIssue(id: number): Promise<TrackedIssue | undefined> {
  await initializeTracker();
  return issues.find(i => i.id === id);
}

/**
 * Get all issues, optionally filtered
 */
export async function getIssues(filter?: IssueFilter): Promise<TrackedIssue[]> {
  await initializeTracker(filter?.includeCompleted);

  let result = [...issues];

  if (filter?.type) {
    result = result.filter(i => i.type === filter.type);
  }

  if (filter?.status) {
    result = result.filter(i => i.status === filter.status);
  }

  return result;
}

/**
 * Update issue status with appropriate timestamp
 */
export async function updateIssueStatus(id: number, status: IssueStatus): Promise<TrackedIssue | undefined> {
  await initializeTracker();

  const issue = issues.find(i => i.id === id);
  if (!issue) return undefined;

  issue.status = status;

  // Set appropriate timestamp
  const now = new Date();
  switch (status) {
    case 'acknowledged':
      issue.acknowledgedAt = now;
      break;
    case 'in_progress':
      issue.startedAt = now;
      break;
    case 'fixed':
    case 'implemented':
      issue.resolvedAt = now;
      break;
  }

  await saveIssuesToCSV();
  return issue;
}

/**
 * Update the sequence file for an issue
 */
export async function updateIssueSequenceFile(id: number, sequenceFile: string): Promise<TrackedIssue | undefined> {
  await initializeTracker();

  const issue = issues.find(i => i.id === id);
  if (!issue) return undefined;

  issue.sequenceFile = sequenceFile;
  await saveIssuesToCSV();
  return issue;
}

/**
 * Save a sequence file to the interactions folder and link it to an issue
 */
export async function saveIssueSequence(
  issueId: number,
  issueType: 'bug' | 'feature',
  issueDescription: string,
  sequenceData: Record<string, any>,
  comment?: string
): Promise<{ success: boolean; filename?: string; error?: string }> {
  const { promises: fs } = await import('fs');
  const { join } = await import('path');

  const sequencesDir = getInteractionSequencesDir();
  const filename = generateSequenceFilename(issueType, issueId, issueDescription);
  const sequenceNameForFile = filename.replace(/\.json$/, '');

  try {
    await fs.mkdir(sequencesDir, { recursive: true });
    const dataToSave = {
      ...sequenceData,
      name: sequenceNameForFile,
      _comment: comment || `CDP Tools sequence for ${issueType} #${issueId}: ${issueDescription}`,
    };
    await fs.writeFile(
      join(sequencesDir, filename),
      JSON.stringify(dataToSave, null, 2),
      'utf-8'
    );
    await updateIssueSequenceFile(issueId, filename);
    return { success: true, filename };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

/**
 * Acknowledge all pending bugs (sets status to 'acknowledged')
 */
export async function acknowledgeAllBugs(): Promise<TrackedIssue[]> {
  await initializeTracker();

  const pendingBugs = issues.filter(i => i.type === 'bug' && i.status === 'pending');
  const now = new Date();

  for (const bug of pendingBugs) {
    bug.status = 'acknowledged';
    bug.acknowledgedAt = now;
  }

  if (pendingBugs.length > 0) {
    await saveIssuesToCSV();
  }

  return pendingBugs;
}

/**
 * Check if there are pending bugs that should block tools
 */
export async function hasPendingBugs(): Promise<boolean> {
  await initializeTracker();
  return issues.some(i => i.type === 'bug' && i.status === 'pending');
}

/**
 * Get pending bugs for blocking message
 */
export async function getPendingBugs(): Promise<TrackedIssue[]> {
  await initializeTracker();
  return issues.filter(i => i.type === 'bug' && i.status === 'pending');
}

/**
 * Get the sequences directory path for interactions
 */
export function getInteractionSequencesDir(): string {
  return getSequencesDir();
}

/**
 * Generate a sequence filename for an issue
 */
export function generateSequenceFilename(type: IssueType, id: number, description: string): string {
  // Sanitize description for filename
  const sanitized = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 30);

  return `${type}-${String(id).padStart(3, '0')}-${sanitized || 'untitled'}.json`;
}
