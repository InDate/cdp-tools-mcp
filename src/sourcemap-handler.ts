/**
 * Source Map Handler
 * Handles TypeScript to JavaScript mapping for breakpoints
 */

import { SourceMapConsumer } from 'source-map';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface SourcePosition {
  source: string;
  line: number;
  column: number;
}

export interface MappedPosition {
  generatedLine: number;
  generatedColumn: number;
  originalLine: number;
  originalColumn: number;
  source: string;
}

export class SourceMapHandler {
  private sourceMaps: Map<string, SourceMapConsumer> = new Map();

  /**
   * Load a source map from a file
   */
  async loadSourceMap(generatedFilePath: string): Promise<void> {
    try {
      const mapPath = `${generatedFilePath}.map`;
      const mapContent = await fs.readFile(mapPath, 'utf-8');
      const rawSourceMap = JSON.parse(mapContent);

      const consumer = await new SourceMapConsumer(rawSourceMap);
      this.sourceMaps.set(generatedFilePath, consumer);
    } catch (error) {
      // Source map might not exist, which is okay
      console.warn(`Could not load source map for ${generatedFilePath}: ${error}`);
    }
  }

  /**
   * Map a TypeScript position to JavaScript position (for setting breakpoints)
   */
  async mapToGenerated(
    originalSource: string,
    originalLine: number,
    originalColumn: number = 0
  ): Promise<{ generatedFile: string; line: number; column: number } | null> {
    // Try to find the source map that contains this original source
    for (const [generatedFile, consumer] of this.sourceMaps.entries()) {
      const sources = (consumer as any).sources as string[];

      // Check if this source map contains our original source
      const matchingSource = sources.find((s: string) => s.includes(originalSource) || originalSource.includes(s));

      if (matchingSource) {
        const generated = consumer.generatedPositionFor({
          source: matchingSource,
          line: originalLine,
          column: originalColumn,
        });

        if (generated.line !== null && generated.column !== null) {
          return {
            generatedFile,
            line: generated.line,
            column: generated.column,
          };
        }
      }
    }

    return null;
  }

  /**
   * Map a JavaScript position to TypeScript position (for displaying location)
   */
  async mapToOriginal(
    generatedFile: string,
    generatedLine: number,
    generatedColumn: number = 0
  ): Promise<SourcePosition | null> {
    const consumer = this.sourceMaps.get(generatedFile);

    if (!consumer) {
      return null;
    }

    const original = consumer.originalPositionFor({
      line: generatedLine,
      column: generatedColumn,
    });

    if (original.source && original.line !== null) {
      return {
        source: original.source,
        line: original.line,
        column: original.column || 0,
      };
    }

    return null;
  }

  /**
   * Load source map from URL or data URI (for auto-detection)
   */
  async loadSourceMapFromURL(scriptUrl: string, sourceMapURL: string): Promise<void> {
    try {
      // Handle inline data URLs (data:application/json;base64,...)
      if (sourceMapURL.startsWith('data:')) {
        const match = sourceMapURL.match(/^data:application\/json;base64,(.+)$/);
        if (match) {
          const base64Data = match[1];
          const jsonData = Buffer.from(base64Data, 'base64').toString('utf-8');
          const rawSourceMap = JSON.parse(jsonData);
          const consumer = await new SourceMapConsumer(rawSourceMap);
          this.sourceMaps.set(scriptUrl, consumer);
          console.log(`Loaded inline source map for ${scriptUrl}`);
          return;
        }
      }

      // Handle relative URLs - convert to absolute file path
      let mapPath: string;
      if (sourceMapURL.startsWith('http://') || sourceMapURL.startsWith('https://')) {
        // For HTTP URLs, extract the path component and treat as local file
        const url = new URL(sourceMapURL);
        mapPath = url.pathname;
        // Try to make it relative to current working directory
        if (mapPath.startsWith('/')) {
          mapPath = path.join(process.cwd(), mapPath.slice(1));
        }
      } else {
        // Relative path - resolve relative to the script
        const scriptPath = scriptUrl.replace(/^https?:\/\/[^\/]+/, '');
        const scriptDir = path.dirname(scriptPath);
        mapPath = path.join(process.cwd(), scriptDir, sourceMapURL);
      }

      // Load the source map file
      const mapContent = await fs.readFile(mapPath, 'utf-8');
      const rawSourceMap = JSON.parse(mapContent);
      const consumer = await new SourceMapConsumer(rawSourceMap);
      this.sourceMaps.set(scriptUrl, consumer);
      console.log(`Loaded source map for ${scriptUrl} from ${mapPath}`);
    } catch (error) {
      console.warn(`Could not load source map from ${sourceMapURL} for ${scriptUrl}: ${error}`);
    }
  }

  /**
   * Preload source maps from a directory
   */
  async loadSourceMapsFromDirectory(directory: string): Promise<void> {
    try {
      const files = await fs.readdir(directory);

      for (const file of files) {
        if (file.endsWith('.js')) {
          const fullPath = path.join(directory, file);
          await this.loadSourceMap(fullPath);
        }
      }
    } catch (error) {
      console.warn(`Could not load source maps from directory ${directory}: ${error}`);
    }
  }

  /**
   * Clear all loaded source maps
   */
  clear(): void {
    for (const consumer of this.sourceMaps.values()) {
      consumer.destroy();
    }
    this.sourceMaps.clear();
  }

  /**
   * Get all loaded source map files
   */
  getLoadedSourceMaps(): string[] {
    return Array.from(this.sourceMaps.keys());
  }

  /**
   * Check if a source map is loaded for a given file
   */
  hasSourceMap(file: string): boolean {
    return this.sourceMaps.has(file);
  }
}
