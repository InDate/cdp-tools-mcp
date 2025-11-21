/**
 * Command Recorder for capturing and replaying tool invocations
 *
 * Records all tool calls automatically and allows creating named sequences
 * by selecting specific command indices from the history.
 */

import { promises as fs } from 'fs';
import { join } from 'path';

export interface RecordedCommand {
  index: number;
  timestamp: number;
  tool: string;
  params: Record<string, any>;
  description?: string;
}

export interface CommandSequence {
  id: string;
  name: string;
  commandIndices: number[];
  createdAt: number;
}

export interface SavedSequence {
  sequence: CommandSequence;
  commands: RecordedCommand[];
}

export class CommandRecorder {
  private history: RecordedCommand[] = [];
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
  recordCommand(tool: string, params: Record<string, any>, description?: string): void {
    const command: RecordedCommand = {
      index: this.commandCounter++,
      timestamp: Date.now(),
      tool,
      params: JSON.parse(JSON.stringify(params)), // Deep clone
      description,
    };

    this.history.push(command);

    // Trim history if it exceeds max size
    if (this.history.length > this.maxHistorySize) {
      this.history.shift();
    }

    console.error(`[CommandRecorder] Recorded #${command.index}: ${tool}`);
  }

  /**
   * Get command history (most recent first)
   */
  getHistory(limit: number = 50): RecordedCommand[] {
    return [...this.history].reverse().slice(0, limit);
  }

  /**
   * Get a specific command by index
   */
  getCommand(index: number): RecordedCommand | undefined {
    return this.history.find(cmd => cmd.index === index);
  }

  /**
   * Create a sequence from command indices
   */
  createSequence(name: string, commandIndices: number[]): CommandSequence | null {
    // Validate all indices exist
    const invalidIndices = commandIndices.filter(idx => !this.getCommand(idx));
    if (invalidIndices.length > 0) {
      console.error(`[CommandRecorder] Invalid command indices: ${invalidIndices.join(', ')}`);
      return null;
    }

    const sequence: CommandSequence = {
      id: `seq-${Date.now()}`,
      name,
      commandIndices,
      createdAt: Date.now(),
    };

    this.sequences.set(sequence.id, sequence);
    console.error(`[CommandRecorder] Created sequence "${name}" with ${commandIndices.length} commands`);
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
   * Get sequence with full command details
   */
  getSequenceWithCommands(sequenceId: string): { sequence: CommandSequence; commands: RecordedCommand[] } | null {
    const sequence = this.sequences.get(sequenceId);
    if (!sequence) {
      return null;
    }

    const commands = sequence.commandIndices
      .map(idx => this.getCommand(idx))
      .filter((cmd): cmd is RecordedCommand => cmd !== undefined);

    return { sequence, commands };
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
  clearAllSequences(): void {
    this.sequences.clear();
    console.error('[CommandRecorder] All sequences cleared');
  }

  /**
   * Clear command history
   */
  clearHistory(): void {
    this.history = [];
    this.commandCounter = 0;
    console.error('[CommandRecorder] Command history cleared');
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
    const sequenceData = this.getSequenceWithCommands(sequenceId);
    if (!sequenceData) {
      console.error(`[CommandRecorder] Sequence ${sequenceId} not found`);
      return null;
    }

    const { sequence, commands } = sequenceData;

    try {
      // Ensure directory exists
      await fs.mkdir(this.sequencesDir, { recursive: true });

      // Sanitize filename
      const safeFilename = sequence.name.replace(/[^a-z0-9-_]/gi, '-').toLowerCase();
      const filename = `${safeFilename}-${sequence.id}.json`;
      const filepath = join(this.sequencesDir, filename);

      const savedSequence: SavedSequence = {
        sequence,
        commands,
      };

      await fs.writeFile(filepath, JSON.stringify(savedSequence, null, 2));
      console.error(`[CommandRecorder] Saved sequence "${sequence.name}" to ${filepath}`);
      return filepath;
    } catch (error: any) {
      console.error(`[CommandRecorder] Failed to save sequence:`, error);
      return null;
    }
  }

  /**
   * Load a sequence from disk
   */
  async loadSequenceFromDisk(filepath: string): Promise<CommandSequence | null> {
    try {
      const content = await fs.readFile(filepath, 'utf-8');
      const savedSequence: SavedSequence = JSON.parse(content);

      // Add commands to history if they don't exist
      for (const cmd of savedSequence.commands) {
        const existing = this.getCommand(cmd.index);
        if (!existing) {
          // Restore command to history
          this.history.push(cmd);
          // Update counter if needed
          if (cmd.index >= this.commandCounter) {
            this.commandCounter = cmd.index + 1;
          }
        }
      }

      // Re-sort history by index
      this.history.sort((a, b) => a.index - b.index);

      // Add sequence to memory
      this.sequences.set(savedSequence.sequence.id, savedSequence.sequence);

      console.error(`[CommandRecorder] Loaded sequence "${savedSequence.sequence.name}" from disk`);
      return savedSequence.sequence;
    } catch (error: any) {
      console.error(`[CommandRecorder] Failed to load sequence from ${filepath}:`, error);
      return null;
    }
  }

  /**
   * List saved sequences on disk
   */
  async listSavedSequencesOnDisk(): Promise<Array<{ filename: string; name: string; id: string }>> {
    try {
      // Ensure directory exists
      await fs.mkdir(this.sequencesDir, { recursive: true });

      const files = await fs.readdir(this.sequencesDir);
      const jsonFiles = files.filter(f => f.endsWith('.json'));

      const sequences: Array<{ filename: string; name: string; id: string }> = [];

      for (const file of jsonFiles) {
        try {
          const filepath = join(this.sequencesDir, file);
          const content = await fs.readFile(filepath, 'utf-8');
          const savedSequence: SavedSequence = JSON.parse(content);
          sequences.push({
            filename: file,
            name: savedSequence.sequence.name,
            id: savedSequence.sequence.id,
          });
        } catch (error) {
          console.error(`[CommandRecorder] Failed to parse ${file}:`, error);
        }
      }

      return sequences;
    } catch (error: any) {
      console.error(`[CommandRecorder] Failed to list saved sequences:`, error);
      return [];
    }
  }

  /**
   * Delete a sequence from disk
   */
  async deleteSequenceFromDisk(filename: string): Promise<boolean> {
    try {
      const filepath = join(this.sequencesDir, filename);
      await fs.unlink(filepath);
      console.error(`[CommandRecorder] Deleted sequence file: ${filename}`);
      return true;
    } catch (error: any) {
      console.error(`[CommandRecorder] Failed to delete ${filename}:`, error);
      return false;
    }
  }
}
