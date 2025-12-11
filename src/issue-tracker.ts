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
// State - minimal, only tracks next ID
// =============================================================================

let nextIssueId = 1;
let nextIdInitialized = false;

// =============================================================================
// File Paths
// =============================================================================

function getIssuesDir(): string {
  return getOutputPath('issues');
}

function getSequencesDir(): string {
  return getOutputPath('issues', 'sequences');
}

function getIssuesFilePath(): string {
  return join(getIssuesDir(), 'issues.csv');
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

/**
 * Read all issues from CSV, optionally filtering
 * Does NOT modify any global state except nextIssueId
 */
async function readIssuesFromCSV(filter?: { includeCompleted?: boolean }): Promise<TrackedIssue[]> {
  const filepath = getIssuesFilePath();
  const includeCompleted = filter?.includeCompleted ?? false;

  try {
    const content = await fs.readFile(filepath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());

    // Skip header
    if (lines.length > 0 && lines[0].startsWith('id,')) {
      lines.shift();
    }

    const result: TrackedIssue[] = [];
    let maxId = 0;

    for (const line of lines) {
      const issue = csvRowToIssue(line);
      if (issue) {
        // Filter completed issues only for return value, but always track maxId
        if (includeCompleted || (issue.status !== 'fixed' && issue.status !== 'implemented')) {
          result.push(issue);
        }
        if (issue.id > maxId) maxId = issue.id;
      }
    }

    // Update nextIssueId based on what's in the file
    if (maxId >= nextIssueId) {
      nextIssueId = maxId + 1;
    }
    nextIdInitialized = true;

    return result;
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      // File doesn't exist yet
      nextIdInitialized = true;
      return [];
    }
    throw error;
  }
}

/**
 * Initialize nextIssueId by scanning the file (if not already done)
 */
async function ensureNextIdInitialized(): Promise<void> {
  if (nextIdInitialized) return;

  const filepath = getIssuesFilePath();
  try {
    const content = await fs.readFile(filepath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());

    let maxId = 0;
    for (const line of lines) {
      if (line.startsWith('id,')) continue; // skip header
      const issue = csvRowToIssue(line);
      if (issue && issue.id > maxId) {
        maxId = issue.id;
      }
    }
    nextIssueId = maxId + 1;
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
    nextIssueId = 1;
  }
  nextIdInitialized = true;
}

/**
 * Append a single issue to the CSV file (does not rewrite existing data)
 */
async function appendIssueToCSV(issue: TrackedIssue): Promise<void> {
  const filepath = getIssuesFilePath();
  const dir = dirname(filepath);

  // Ensure directory exists
  await fs.mkdir(dir, { recursive: true });

  // Check if file exists and has content
  let needsHeader = false;
  try {
    const stat = await fs.stat(filepath);
    if (stat.size === 0) needsHeader = true;
  } catch (error: any) {
    if (error.code === 'ENOENT') needsHeader = true;
    else throw error;
  }

  const row = issueToCSVRow(issue);
  if (needsHeader) {
    await fs.writeFile(filepath, CSV_HEADER + '\n' + row + '\n', 'utf-8');
  } else {
    await fs.appendFile(filepath, row + '\n', 'utf-8');
  }
}

/**
 * Update a specific issue in the CSV by ID (reads file, modifies line, writes back)
 * This preserves ALL other lines exactly as they are
 */
async function updateIssueInCSV(id: number, updater: (issue: TrackedIssue) => TrackedIssue): Promise<TrackedIssue | null> {
  const filepath = getIssuesFilePath();

  let content: string;
  try {
    content = await fs.readFile(filepath, 'utf-8');
  } catch (error: any) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }

  const lines = content.split('\n');
  let updated: TrackedIssue | null = null;
  let foundIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('id,')) continue; // skip empty and header

    const issue = csvRowToIssue(lines[i]);
    if (issue && issue.id === id) {
      updated = updater(issue);
      lines[i] = issueToCSVRow(updated);
      foundIndex = i;
      break;
    }
  }

  if (updated && foundIndex >= 0) {
    await fs.writeFile(filepath, lines.join('\n'), 'utf-8');
  }

  return updated;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Initialize the issue tracker - ensures directories exist
 * No longer loads issues into memory; they're read on demand
 */
export async function initializeTracker(_includeCompleted: boolean = false): Promise<void> {
  // Ensure directories exist
  await fs.mkdir(getIssuesDir(), { recursive: true });
  await fs.mkdir(getSequencesDir(), { recursive: true });

  // Initialize next ID from file if needed
  await ensureNextIdInitialized();
}

/**
 * Add a new issue - appends to CSV without rewriting existing data
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

  // Append only - does not rewrite existing data
  await appendIssueToCSV(issue);

  return issue;
}

/**
 * Get a single issue by ID - reads directly from CSV
 */
export async function getIssue(id: number): Promise<TrackedIssue | undefined> {
  await initializeTracker();
  // Read all issues (including completed) to find by ID
  const allIssues = await readIssuesFromCSV({ includeCompleted: true });
  return allIssues.find(i => i.id === id);
}

/**
 * Get all issues, optionally filtered - reads directly from CSV
 */
export async function getIssues(filter?: IssueFilter): Promise<TrackedIssue[]> {
  await initializeTracker();

  // Read from CSV with completed filter
  let result = await readIssuesFromCSV({ includeCompleted: filter?.includeCompleted });

  if (filter?.type) {
    result = result.filter(i => i.type === filter.type);
  }

  if (filter?.status) {
    result = result.filter(i => i.status === filter.status);
  }

  return result;
}

/**
 * Update issue status with appropriate timestamp - modifies only the specific line
 */
export async function updateIssueStatus(id: number, status: IssueStatus): Promise<TrackedIssue | undefined> {
  await initializeTracker();

  const updated = await updateIssueInCSV(id, (issue) => {
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

    return issue;
  });

  return updated ?? undefined;
}

/**
 * Update the sequence file for an issue - modifies only the specific line
 */
export async function updateIssueSequenceFile(id: number, sequenceFile: string): Promise<TrackedIssue | undefined> {
  await initializeTracker();

  const updated = await updateIssueInCSV(id, (issue) => {
    issue.sequenceFile = sequenceFile;
    return issue;
  });

  return updated ?? undefined;
}

/**
 * Save a sequence file to the issues folder and link it to an issue
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

  const sequencesDir = getIssueSequencesDir();
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

  // Read all issues to find pending bugs
  const allIssues = await readIssuesFromCSV({ includeCompleted: true });
  const pendingBugs = allIssues.filter(i => i.type === 'bug' && i.status === 'pending');

  // Update each pending bug individually
  const acknowledged: TrackedIssue[] = [];
  for (const bug of pendingBugs) {
    const updated = await updateIssueInCSV(bug.id, (issue) => {
      issue.status = 'acknowledged';
      issue.acknowledgedAt = new Date();
      return issue;
    });
    if (updated) acknowledged.push(updated);
  }

  return acknowledged;
}

/**
 * Check if there are pending bugs that should block tools
 */
export async function hasPendingBugs(): Promise<boolean> {
  await initializeTracker();
  const allIssues = await readIssuesFromCSV({ includeCompleted: true });
  return allIssues.some(i => i.type === 'bug' && i.status === 'pending');
}

/**
 * Get pending bugs for blocking message
 */
export async function getPendingBugs(): Promise<TrackedIssue[]> {
  await initializeTracker();
  const allIssues = await readIssuesFromCSV({ includeCompleted: true });
  return allIssues.filter(i => i.type === 'bug' && i.status === 'pending');
}

/**
 * Get the sequences directory path for issues
 */
export function getIssueSequencesDir(): string {
  return getSequencesDir();
}

// Alias for backwards compatibility
export const getInteractionSequencesDir = getIssueSequencesDir;

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
