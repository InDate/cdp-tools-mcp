/**
 * Command Recorder for capturing and replaying tool invocations
 *
 * Records all tool calls automatically and allows creating named sequences
 * by selecting specific command indices from the history.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { debugLog, isHistoryLogEnabled, logToHistoryFile } from './debug-logger.js';
import { sanitizeReference } from './reference-validator.js';
import { getOutputPath } from './helpers/paths.js';
import { atomicWriteFile } from './atomic-write.js';
import { getIssueSequencesDir, getIssuesBySequenceFile } from './issue-tracker.js';

export interface RecordedCommand {
  tool: string;
  params: Record<string, any>;
  delay?: number;  // ms to wait before executing this command
  comment?: string;  // user comment describing expected behavior
}

export interface CommandSequence {
  id: string;
  name: string;
  description?: string;
  expectedOutcome?: string;
  startUrl?: string;
  commands: RecordedCommand[];
  createdAt: number;
}

// Internal history tracking (includes index and timestamp)
interface HistoryCommand extends RecordedCommand {
  index: number;
  timestamp: number;
}

// Active sequence state for step-through debugging
export interface ActiveSequenceState {
  sequenceId: string;
  sequenceName: string;
  connectionReason: string;
  currentStep: number;        // 0-indexed, next step to execute
  totalSteps: number;
  pausedAt: number;           // Timestamp when paused
  historyIndexAtPause: number; // History index when we paused (to track new commands)
  /** Variable store for {{var:name.path}} interpolation, shared by reference
   *  with the ExecutionContext across run/step/finish calls for this pause. */
  capturedVariables?: Record<string, any>;
  /** {{timestamp}} value for this run, fixed at first resolution so it stays
   *  stable across every step of the same run (including step/finish calls). */
  runTimestamp?: number;
}

export class CommandRecorder {
  private history: HistoryCommand[] = [];
  private sequences: Map<string, CommandSequence> = new Map();
  private commandCounter = 0;
  private maxHistorySize = 1000; // Keep last 1000 commands
  private activeSequence: ActiveSequenceState | null = null;
  private historyViewedWhilePaused: boolean = false;

  /**
   * Get the sequences directory for a specific scope
   */
  getSequencesDir(global: boolean = false): string {
    return getOutputPath('sequences', { global });
  }

  /**
   * Set active sequence state (for step-through)
   */
  setActiveSequence(state: ActiveSequenceState | null): void {
    this.activeSequence = state;
    // Reset history viewed flag when sequence state changes
    this.historyViewedWhilePaused = false;
  }

  /**
   * Mark that history was viewed while paused (enables insert)
   */
  markHistoryViewed(): void {
    if (this.activeSequence) {
      this.historyViewedWhilePaused = true;
    }
  }

  /**
   * Reset history viewed flag (called when other actions are taken)
   */
  resetHistoryViewed(): void {
    this.historyViewedWhilePaused = false;
  }

  /**
   * Check if history was viewed while paused
   */
  wasHistoryViewed(): boolean {
    return this.historyViewedWhilePaused;
  }

  /**
   * Get active sequence state
   */
  getActiveSequence(): ActiveSequenceState | null {
    return this.activeSequence;
  }

  /**
   * Update current step in active sequence
   */
  updateActiveSequenceStep(step: number): void {
    if (this.activeSequence) {
      this.activeSequence.currentStep = step;
    }
  }

  /**
   * Get commands recorded since sequence was paused
   */
  getCommandsSincePause(): HistoryCommand[] {
    if (!this.activeSequence) return [];
    return this.history.filter(cmd => cmd.index > this.activeSequence!.historyIndexAtPause);
  }

  /**
   * Get current history index (for tracking pause point)
   */
  getCurrentHistoryIndex(): number {
    return this.history.length > 0 ? this.history[this.history.length - 1].index : -1;
  }

  /**
   * Record a command (always-on, automatic)
   */
  async recordCommand(tool: string, params: Record<string, any>, options?: { delay?: number; comment?: string }): Promise<void> {
    // Reset history viewed flag when any command is recorded
    // (user must view history again before inserting)
    this.historyViewedWhilePaused = false;

    // Clone params and remove connectionReason to make sequences reusable
    const paramsClone = JSON.parse(JSON.stringify(params));
    delete paramsClone.connectionReason;

    // Sanitize 'reference' param for tools that create connections
    // This ensures recorded sequences use the same reference format as the actual connection
    if (paramsClone.reference && ['launchChrome', 'connectDebugger'].includes(tool)) {
      paramsClone.reference = sanitizeReference(paramsClone.reference);
    }
    // Sanitize 'newReference' for tab rename operations
    if (paramsClone.newReference && tool === 'tab' && paramsClone.action === 'rename') {
      paramsClone.newReference = sanitizeReference(paramsClone.newReference);
    }

    const command: HistoryCommand = {
      index: this.commandCounter++,
      timestamp: Date.now(),
      tool,
      params: paramsClone,
      ...(options?.delay !== undefined && { delay: options.delay }),
      ...(options?.comment && { comment: options.comment }),
    };

    this.history.push(command);

    // Trim history if it exceeds max size
    if (this.history.length > this.maxHistorySize) {
      this.history.shift();
    }

    await debugLog('command-recorder', `Recorded #${command.index}: ${tool}`);

    // Write to history.log in replay-compatible format when history logging is enabled
    if (isHistoryLogEnabled()) {
      const historyEntry: RecordedCommand = { tool, params: paramsClone };
      await logToHistoryFile(JSON.stringify(historyEntry));
    }
  }

  /**
   * Get command history (most recent first)
   */
  getHistory(limit: number = 50): HistoryCommand[] {
    return [...this.history].reverse().slice(0, limit);
  }

  /**
   * Get a specific command by index
   */
  getCommand(index: number): HistoryCommand | undefined {
    return this.history.find(cmd => cmd.index === index);
  }

  /**
   * Create a sequence from command indices
   */
  async createSequence(
    name: string,
    commandIndices: number[],
    options?: {
      description?: string;
      expectedOutcome?: string;
      startUrl?: string;
      /**
       * Called with the fully built candidate BEFORE it replaces any same-named
       * sequence in memory. Return false to reject: nothing is removed and nothing
       * is stored, so a rejected create leaves the existing sequence intact.
       * (Validating after the fact deleted the good copy and then rejected the bad
       * one, leaving the user with neither.)
       */
      validate?: (candidate: CommandSequence) => boolean;
    }
  ): Promise<CommandSequence | null> {
    // Validate all indices exist and get commands
    const commands: RecordedCommand[] = [];
    for (const idx of commandIndices) {
      const cmd = this.getCommand(idx);
      if (!cmd) {
        await debugLog('command-recorder', `Invalid command index: ${idx}`);
        return null;
      }
      // Strip index and timestamp for the sequence, but keep delay and comment
      commands.push({
        tool: cmd.tool,
        params: cmd.params,
        ...(cmd.delay !== undefined && { delay: cmd.delay }),
        ...(cmd.comment && { comment: cmd.comment }),
      });
    }

    // Extract startUrl from commands if not explicitly provided
    let startUrl = options?.startUrl;
    if (!startUrl) {
      // Look for the first navigate goto action
      for (const cmd of commands) {
        if (cmd.tool === 'navigate' && cmd.params.action === 'goto' && cmd.params.url) {
          startUrl = cmd.params.url;
          break;
        }
      }
    }

    const sequence: CommandSequence = {
      id: `seq-${Date.now()}`,
      name,
      ...(options?.description && { description: options.description }),
      ...(options?.expectedOutcome && { expectedOutcome: options.expectedOutcome }),
      ...(startUrl && { startUrl }),
      commands,
      createdAt: Date.now(),
    };

    // Validate before anything destructive happens (see options.validate).
    if (options?.validate && !options.validate(sequence)) {
      await debugLog('command-recorder', `Rejected sequence "${name}" (validation failed) - existing sequence left intact`);
      return null;
    }

    // Dedupe by name so re-creating a sequence replaces the old in-memory copy
    // rather than leaving a stale one that loadSequence({name}) would resolve (#75).
    this.removeSequenceByName(name);
    this.sequences.set(sequence.id, sequence);
    await debugLog('command-recorder', `Created sequence "${name}" with ${commands.length} commands${startUrl ? `, startUrl: ${startUrl}` : ''}`);
    return sequence;
  }

  /**
   * Create a sequence directly from commands (not from history)
   */
  async createSequenceFromCommands(
    name: string,
    commands: RecordedCommand[],
    options?: { description?: string; expectedOutcome?: string; startUrl?: string }
  ): Promise<CommandSequence> {
    // Extract startUrl from commands if not explicitly provided
    let startUrl = options?.startUrl;
    if (!startUrl) {
      for (const cmd of commands) {
        if (cmd.tool === 'navigate' && cmd.params.action === 'goto' && cmd.params.url) {
          startUrl = cmd.params.url;
          break;
        }
      }
    }

    const sequence: CommandSequence = {
      id: `seq-${Date.now()}`,
      name,
      ...(options?.description && { description: options.description }),
      ...(options?.expectedOutcome && { expectedOutcome: options.expectedOutcome }),
      ...(startUrl && { startUrl }),
      commands,
      createdAt: Date.now(),
    };

    // Dedupe by name (see createSequence / #75).
    this.removeSequenceByName(name);
    this.sequences.set(sequence.id, sequence);
    await debugLog('command-recorder', `Created sequence "${name}" from commands with ${commands.length} commands${startUrl ? `, startUrl: ${startUrl}` : ''}`);
    return sequence;
  }

  /**
   * Check if a sequence with the given name exists
   */
  sequenceNameExists(name: string): boolean {
    for (const seq of this.sequences.values()) {
      if (seq.name === name) return true;
    }
    return false;
  }

  /**
   * List all saved sequences
   */
  listSequences(): CommandSequence[] {
    return Array.from(this.sequences.values());
  }

  /**
   * Get a specific sequence by ID
   */
  getSequence(sequenceId: string): CommandSequence | undefined {
    return this.sequences.get(sequenceId);
  }


  /**
   * Delete a sequence
   */
  deleteSequence(sequenceId: string): boolean {
    return this.sequences.delete(sequenceId);
  }

  /**
   * Remove ALL in-memory sequences with the given name. Used on create/reload so a
   * name maps to exactly one sequence — otherwise `loadSequence({name})` resolves the
   * oldest insertion-order match and re-created sequences are silently ignored (#75).
   */
  private removeSequenceByName(name: string): void {
    for (const [id, seq] of this.sequences.entries()) {
      if (seq.name === name) {
        this.sequences.delete(id);
      }
    }
  }

  /**
   * Clear all sequences
   */
  async clearAllSequences(): Promise<void> {
    this.sequences.clear();
    await debugLog('command-recorder', 'All sequences cleared');
  }

  /**
   * Clear command history
   */
  async clearHistory(): Promise<void> {
    this.history = [];
    this.commandCounter = 0;
    await debugLog('command-recorder', 'Command history cleared');
  }

  /**
   * Get statistics
   */
  getStats(): {
    historyCount: number;
    sequenceCount: number;
    oldestCommandIndex: number | null;
    newestCommandIndex: number | null;
  } {
    return {
      historyCount: this.history.length,
      sequenceCount: this.sequences.size,
      oldestCommandIndex: this.history.length > 0 ? this.history[0].index : null,
      newestCommandIndex: this.history.length > 0 ? this.history[this.history.length - 1].index : null,
    };
  }

  /**
   * Save a sequence to disk
   * @param sequenceId - ID of the sequence to save
   * @param global - If true, save to global ~/.cdp-tools/sequences/, otherwise working directory
   */
  async saveSequenceToDisk(
    sequenceId: string,
    global: boolean = false,
    overwrite: boolean = false
  ): Promise<{ success: true; filepath: string } | { success: false; error: string; conflict?: boolean; filepath?: string } | null> {
    const sequence = this.getSequence(sequenceId);
    if (!sequence) {
      await debugLog('command-recorder', `Sequence ${sequenceId} not found`);
      return null;
    }

    const targetDir = this.getSequencesDir(global);

    try {
      // Sanitize filename - use name directly
      // Note: atomicWriteFile handles directory creation
      const safeFilename = sequence.name.replace(/[^a-z0-9-_]/gi, '-').toLowerCase();
      const filename = `${safeFilename}.json`;
      const filepath = join(targetDir, filename);

      // Check for conflict
      try {
        await fs.access(filepath);
        // File exists
        if (!overwrite) {
          return { success: false, error: 'File already exists', conflict: true, filepath };
        }
      } catch {
        // File doesn't exist, proceed
      }

      // Add usage comment to exported file
      const exportData = {
        _comment: 'CDP Tools replay sequence. Load with: replay({ action: "load", filename: "<this-file>" }), then run with: replay({ action: "run", name: "<this-file>" })',
        ...sequence
      };
      await atomicWriteFile(filepath, JSON.stringify(exportData, null, 2));
      await debugLog('command-recorder', `Saved sequence "${sequence.name}" to ${filepath}`);
      return { success: true, filepath };
    } catch (error: any) {
      await debugLog('command-recorder', `Failed to save sequence: ${error}`);
      return { success: false, error: error.message || String(error) };
    }
  }

  /**
   * Find best matching filename from saved sequences (searches both working dir and global)
   * Supports: exact match, with/without .json, name prefix (returns latest by timestamp)
   * Returns the full path to the matched file
   */
  async findMatchingFilename(searchTerm: string): Promise<{ filename: string; fullPath: string; matchType: string; location: string } | null> {
    const savedSequences = await this.listSavedSequencesOnDisk();
    if (savedSequences.length === 0) return null;

    const term = searchTerm.toLowerCase();
    const termWithoutJson = term.endsWith('.json') ? term.slice(0, -5) : term;

    // 1. Exact filename match (with or without .json)
    const exactMatch = savedSequences.find(s =>
      s.filename.toLowerCase() === term ||
      s.filename.toLowerCase() === termWithoutJson + '.json'
    );
    if (exactMatch) {
      return { filename: exactMatch.filename, fullPath: exactMatch.fullPath, matchType: 'exact', location: exactMatch.location };
    }

    // 2. Exact name match
    const nameMatch = savedSequences.find(s => s.name.toLowerCase() === termWithoutJson);
    if (nameMatch) {
      return { filename: nameMatch.filename, fullPath: nameMatch.fullPath, matchType: 'name', location: nameMatch.location };
    }

    // 3. Filename starts with search term (gets latest by sorting)
    const prefixMatches = savedSequences.filter(s =>
      s.filename.toLowerCase().startsWith(termWithoutJson)
    );
    if (prefixMatches.length > 0) {
      // Sort by filename descending to get latest timestamp
      prefixMatches.sort((a, b) => b.filename.localeCompare(a.filename));
      return { filename: prefixMatches[0].filename, fullPath: prefixMatches[0].fullPath, matchType: 'prefix', location: prefixMatches[0].location };
    }

    // 4. Name starts with search term
    const namePrefixMatches = savedSequences.filter(s =>
      s.name.toLowerCase().startsWith(termWithoutJson)
    );
    if (namePrefixMatches.length > 0) {
      namePrefixMatches.sort((a, b) => b.filename.localeCompare(a.filename));
      return { filename: namePrefixMatches[0].filename, fullPath: namePrefixMatches[0].fullPath, matchType: 'name-prefix', location: namePrefixMatches[0].location };
    }

    // 5. Name contains search term
    const containsMatches = savedSequences.filter(s =>
      s.name.toLowerCase().includes(termWithoutJson)
    );
    if (containsMatches.length > 0) {
      containsMatches.sort((a, b) => b.filename.localeCompare(a.filename));
      return { filename: containsMatches[0].filename, fullPath: containsMatches[0].fullPath, matchType: 'contains', location: containsMatches[0].location };
    }

    return null;
  }

  /**
   * Parse a sequence file from disk WITHOUT touching in-memory state.
   * Split out from registration so a caller can validate the parsed candidate
   * before anything same-named is evicted (see registerLoadedSequence).
   */
  private async parseSequenceFile(filepath: string): Promise<CommandSequence> {
    const content = await fs.readFile(filepath, 'utf-8');
    return JSON.parse(content) as CommandSequence;
  }

  /**
   * Register a parsed sequence in memory, replacing any same-named copy.
   * Validation (if supplied) runs BEFORE the removal, so a rejected load leaves
   * the pre-existing sequence completely intact instead of deleting the good copy
   * and then rejecting the bad one, leaving the user with neither.
   */
  private registerLoadedSequence(
    sequence: CommandSequence,
    validate?: (candidate: CommandSequence) => boolean
  ): boolean {
    if (validate && !validate(sequence)) return false;

    // Remove any existing sequence with the same name (may have different ID)
    this.removeSequenceByName(sequence.name);
    this.sequences.set(sequence.id, sequence);
    return true;
  }

  /**
   * Load a sequence from disk (supports fuzzy filename matching)
   *
   * @param options.validate - Called with the parsed candidate BEFORE it replaces any
   *   same-named in-memory sequence. Return false to reject: nothing is removed and
   *   nothing is stored, and this method returns null.
   */
  async loadSequenceFromDisk(
    filename: string,
    options?: { validate?: (candidate: CommandSequence) => boolean }
  ): Promise<CommandSequence | null> {
    try {
      // Support absolute paths directly
      if (filename.startsWith('/') || filename.includes(':\\')) {
        const sequence = await this.parseSequenceFile(filename);
        if (!this.registerLoadedSequence(sequence, options?.validate)) {
          await debugLog('command-recorder', `Rejected sequence "${sequence.name}" from ${filename} (validation failed) - existing sequence left intact`);
          return null;
        }
        await debugLog('command-recorder', `Loaded sequence "${sequence.name}" from ${filename}`);
        return sequence;
      }

      // Try fuzzy matching for relative filenames
      const match = await this.findMatchingFilename(filename);
      if (!match) {
        await debugLog('command-recorder', `No matching sequence found for "${filename}"`);
        return null;
      }

      const filepath = match.fullPath;
      await debugLog('command-recorder', `Matched "${filename}" to "${match.filename}" (${match.matchType})`);

      const sequence = await this.parseSequenceFile(filepath);
      if (!this.registerLoadedSequence(sequence, options?.validate)) {
        await debugLog('command-recorder', `Rejected sequence "${sequence.name}" from ${filepath} (validation failed) - existing sequence left intact`);
        return null;
      }

      await debugLog('command-recorder', `Loaded sequence "${sequence.name}" from ${filepath}`);
      return sequence;
    } catch (error: any) {
      await debugLog('command-recorder', `Failed to load sequence from ${filename}: ${error}`);
      return null;
    }
  }

  /**
   * List saved sequences on disk from a specific directory
   */
  private async listSequencesFromDir(dir: string, location: 'working-dir' | 'global' | 'issues'): Promise<Array<{ filename: string; name: string; id: string; commandCount: number; description?: string; expectedOutcome?: string; startUrl?: string; location: string; fullPath: string }>> {
    const sequences: Array<{ filename: string; name: string; id: string; commandCount: number; description?: string; expectedOutcome?: string; startUrl?: string; location: string; fullPath: string }> = [];

    try {
      // Read directory - if it doesn't exist, return empty list (no side effects)
      let files: string[];
      try {
        files = await fs.readdir(dir);
      } catch (err: any) {
        if (err.code === 'ENOENT') return sequences; // Directory doesn't exist yet
        throw err;
      }
      const jsonFiles = files.filter(f => f.endsWith('.json'));

      for (const file of jsonFiles) {
        try {
          const filepath = join(dir, file);
          const content = await fs.readFile(filepath, 'utf-8');
          const sequence: CommandSequence = JSON.parse(content);
          sequences.push({
            filename: file,
            name: sequence.name,
            id: sequence.id,
            commandCount: sequence.commands?.length || 0,
            location,
            fullPath: filepath,
            ...(sequence.description && { description: sequence.description }),
            ...(sequence.expectedOutcome && { expectedOutcome: sequence.expectedOutcome }),
            ...(sequence.startUrl && { startUrl: sequence.startUrl }),
          });
        } catch (error) {
          await debugLog('command-recorder', `Failed to parse ${file}: ${error}`);
        }
      }
    } catch (error: any) {
      await debugLog('command-recorder', `Failed to list sequences from ${dir}: ${error}`);
    }

    return sequences;
  }

  /**
   * List saved sequences on disk (checks both working directory and global)
   */
  async listSavedSequencesOnDisk(): Promise<Array<{ filename: string; name: string; id: string; commandCount: number; description?: string; expectedOutcome?: string; startUrl?: string; location: string; fullPath: string }>> {
    const workingDir = this.getSequencesDir(false);
    const globalDir = this.getSequencesDir(true);

    // Get sequences from both locations
    const workingDirSequences = await this.listSequencesFromDir(workingDir, 'working-dir');
    const globalSequences = await this.listSequencesFromDir(globalDir, 'global');

    // If working dir and global are the same (fallback case), avoid duplicates
    if (workingDir === globalDir) {
      return workingDirSequences;
    }

    return [...workingDirSequences, ...globalSequences];
  }

  /**
   * List issue sequences on disk with associated issue metadata
   */
  async listIssueSequencesOnDisk(): Promise<Array<{
    filename: string;
    name: string;
    id: string;
    commandCount: number;
    description?: string;
    expectedOutcome?: string;
    startUrl?: string;
    location: string;
    fullPath: string;
    issueId?: number;
    issueType?: string;
    issueStatus?: string;
  }>> {
    const issuesDir = getIssueSequencesDir();
    const sequences = await this.listSequencesFromDir(issuesDir, 'issues');

    // Get issue metadata
    const issueMap = await getIssuesBySequenceFile();

    return sequences.map(seq => {
      const issue = issueMap.get(seq.filename);
      return {
        ...seq,
        issueId: issue?.id,
        issueType: issue?.type,
        issueStatus: issue?.status
      };
    });
  }

  /**
   * Delete a sequence from disk (supports fuzzy filename matching)
   */
  async deleteSequenceFromDisk(filename: string): Promise<boolean> {
    try {
      // Support absolute paths directly
      if (filename.startsWith('/') || filename.includes(':\\')) {
        await fs.unlink(filename);
        await debugLog('command-recorder', `Deleted sequence file: ${filename}`);
        return true;
      }

      // Try fuzzy matching for relative filenames
      const match = await this.findMatchingFilename(filename);
      if (!match) {
        await debugLog('command-recorder', `No matching sequence found for "${filename}"`);
        return false;
      }

      const filepath = match.fullPath;
      await debugLog('command-recorder', `Matched "${filename}" to "${match.filename}" (${match.matchType})`);

      await fs.unlink(filepath);
      await debugLog('command-recorder', `Deleted sequence file: ${filepath}`);
      return true;
    } catch (error: any) {
      await debugLog('command-recorder', `Failed to delete ${filename}: ${error}`);
      return false;
    }
  }
}
