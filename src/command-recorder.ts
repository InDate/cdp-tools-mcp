/**
 * Command Recorder for capturing and replaying tool invocations
 *
 * Records all tool calls automatically and allows creating named sequences
 * by selecting specific command indices from the history.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { debugLog } from './debug-logger.js';

export interface RecordedCommand {
  tool: string;
  params: Record<string, any>;
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

export class CommandRecorder {
  private history: HistoryCommand[] = [];
  private sequences: Map<string, CommandSequence> = new Map();
  private commandCounter = 0;
  private maxHistorySize = 1000; // Keep last 1000 commands
  private sequencesDir: string;

  constructor() {
    this.sequencesDir = join(process.cwd(), '.claude', 'sequences');
  }

  /**
   * Record a command (always-on, automatic)
   */
  async recordCommand(tool: string, params: Record<string, any>): Promise<void> {
    // Clone params and remove connectionReason to make sequences reusable
    const paramsClone = JSON.parse(JSON.stringify(params));
    delete paramsClone.connectionReason;

    const command: HistoryCommand = {
      index: this.commandCounter++,
      timestamp: Date.now(),
      tool,
      params: paramsClone,
    };

    this.history.push(command);

    // Trim history if it exceeds max size
    if (this.history.length > this.maxHistorySize) {
      this.history.shift();
    }

    await debugLog('command-recorder', `Recorded #${command.index}: ${tool}`);
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
    options?: { description?: string; expectedOutcome?: string; startUrl?: string }
  ): Promise<CommandSequence | null> {
    // Validate all indices exist and get commands
    const commands: RecordedCommand[] = [];
    for (const idx of commandIndices) {
      const cmd = this.getCommand(idx);
      if (!cmd) {
        await debugLog('command-recorder', `Invalid command index: ${idx}`);
        return null;
      }
      // Strip index and timestamp for the sequence
      commands.push({
        tool: cmd.tool,
        params: cmd.params,
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

    this.sequences.set(sequence.id, sequence);
    await debugLog('command-recorder', `Created sequence "${name}" with ${commands.length} commands${startUrl ? `, startUrl: ${startUrl}` : ''}`);
    return sequence;
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
   */
  async saveSequenceToDisk(sequenceId: string): Promise<string | null> {
    const sequence = this.getSequence(sequenceId);
    if (!sequence) {
      await debugLog('command-recorder', `Sequence ${sequenceId} not found`);
      return null;
    }

    try {
      // Ensure directory exists
      await fs.mkdir(this.sequencesDir, { recursive: true });

      // Sanitize filename - use name + short timestamp
      const safeFilename = sequence.name.replace(/[^a-z0-9-_]/gi, '-').toLowerCase();
      const shortId = Date.now().toString().slice(-6); // Last 6 digits of timestamp
      const filename = `${safeFilename}-${shortId}.json`;
      const filepath = join(this.sequencesDir, filename);

      // Add usage comment to exported file
      const exportData = {
        _comment: 'CDP Tools replay sequence. Load with: replay({ action: "load", filename: "<this-file>" }), then run with: replay({ action: "replay", sequenceId: "<id>" })',
        ...sequence
      };
      await fs.writeFile(filepath, JSON.stringify(exportData, null, 2));
      await debugLog('command-recorder', `Saved sequence "${sequence.name}" to ${filepath}`);
      return filepath;
    } catch (error: any) {
      await debugLog('command-recorder', `Failed to save sequence: ${error}`);
      return null;
    }
  }

  /**
   * Load a sequence from disk
   */
  async loadSequenceFromDisk(filename: string): Promise<CommandSequence | null> {
    try {
      // Support both full paths and relative filenames
      const filepath = filename.startsWith('/') || filename.includes(':\\')
        ? filename  // Absolute path (Unix or Windows)
        : join(this.sequencesDir, filename);  // Relative to sequences directory

      const content = await fs.readFile(filepath, 'utf-8');
      const sequence: CommandSequence = JSON.parse(content);

      // Add sequence to memory
      this.sequences.set(sequence.id, sequence);

      await debugLog('command-recorder', `Loaded sequence "${sequence.name}" from ${filepath}`);
      return sequence;
    } catch (error: any) {
      await debugLog('command-recorder', `Failed to load sequence from ${filename}: ${error}`);
      return null;
    }
  }

  /**
   * List saved sequences on disk
   */
  async listSavedSequencesOnDisk(): Promise<Array<{ filename: string; name: string; id: string; description?: string; expectedOutcome?: string; startUrl?: string }>> {
    try {
      // Ensure directory exists
      await fs.mkdir(this.sequencesDir, { recursive: true });

      const files = await fs.readdir(this.sequencesDir);
      const jsonFiles = files.filter(f => f.endsWith('.json'));

      const sequences: Array<{ filename: string; name: string; id: string; description?: string; expectedOutcome?: string; startUrl?: string }> = [];

      for (const file of jsonFiles) {
        try {
          const filepath = join(this.sequencesDir, file);
          const content = await fs.readFile(filepath, 'utf-8');
          const sequence: CommandSequence = JSON.parse(content);
          sequences.push({
            filename: file,
            name: sequence.name,
            id: sequence.id,
            ...(sequence.description && { description: sequence.description }),
            ...(sequence.expectedOutcome && { expectedOutcome: sequence.expectedOutcome }),
            ...(sequence.startUrl && { startUrl: sequence.startUrl }),
          });
        } catch (error) {
          await debugLog('command-recorder', `Failed to parse ${file}: ${error}`);
        }
      }

      return sequences;
    } catch (error: any) {
      await debugLog('command-recorder', `Failed to list saved sequences: ${error}`);
      return [];
    }
  }

  /**
   * Delete a sequence from disk
   */
  async deleteSequenceFromDisk(filename: string): Promise<boolean> {
    try {
      // Support both full paths and relative filenames
      const filepath = filename.startsWith('/') || filename.includes(':\\')
        ? filename  // Absolute path (Unix or Windows)
        : join(this.sequencesDir, filename);  // Relative to sequences directory

      await fs.unlink(filepath);
      await debugLog('command-recorder', `Deleted sequence file: ${filepath}`);
      return true;
    } catch (error: any) {
      await debugLog('command-recorder', `Failed to delete ${filename}: ${error}`);
      return false;
    }
  }
}
