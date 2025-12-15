import * as fs from 'fs';
import * as path from 'path';

/** Pattern: .{basename}.tmp.{timestamp}.{random} */
const TEMP_FILE_PATTERN = /^\.(.+)\.tmp\.(\d+)\.[a-z0-9]+$/;

/**
 * Parse a temp file entry and return its age if it matches the pattern.
 * Returns null if the entry doesn't match the temp file pattern.
 */
function getTempFileAge(entry: string, now: number): { basename: string; age: number } | null {
  const match = entry.match(TEMP_FILE_PATTERN);
  if (!match) return null;

  const timestamp = parseInt(match[2], 10);
  return { basename: match[1], age: now - timestamp };
}

/**
 * Clean up stale temp files left behind by crashed/killed processes.
 * Removes temp files older than maxAgeMs (default: 5 minutes).
 */
export async function cleanupStaleTempFiles(
  directory: string,
  maxAgeMs: number = 5 * 60 * 1000
): Promise<{ cleaned: string[]; errors: string[] }> {
  const cleaned: string[] = [];
  const errors: string[] = [];

  try {
    const entries = await fs.promises.readdir(directory);
    const now = Date.now();

    for (const entry of entries) {
      const parsed = getTempFileAge(entry, now);
      if (!parsed || parsed.age <= maxAgeMs) continue;

      try {
        await fs.promises.unlink(path.join(directory, entry));
        cleaned.push(entry);
      } catch (err) {
        errors.push(`${entry}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch {
    // Directory doesn't exist or can't be read - not an error
  }

  return { cleaned, errors };
}

/**
 * Synchronous version for use during shutdown.
 * Uses maxAgeMs=0 by default to clean all temp files.
 */
export function cleanupStaleTempFilesSync(
  directory: string,
  maxAgeMs: number = 0
): { cleaned: string[]; errors: string[] } {
  const cleaned: string[] = [];
  const errors: string[] = [];

  try {
    const entries = fs.readdirSync(directory);
    const now = Date.now();

    for (const entry of entries) {
      const parsed = getTempFileAge(entry, now);
      if (!parsed || parsed.age <= maxAgeMs) continue;

      try {
        fs.unlinkSync(path.join(directory, entry));
        cleaned.push(entry);
      } catch (err) {
        errors.push(`${entry}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch {
    // Directory doesn't exist or can't be read - not an error
  }

  return { cleaned, errors };
}

/**
 * Clean up stale temp files for a specific target file.
 * Called before each atomic write to prevent accumulation.
 */
async function cleanupStaleForFile(dir: string, targetBasename: string, maxAgeMs: number = 30 * 1000): Promise<void> {
  try {
    const entries = await fs.promises.readdir(dir);
    const now = Date.now();

    for (const entry of entries) {
      const parsed = getTempFileAge(entry, now);
      if (!parsed || parsed.basename !== targetBasename || parsed.age <= maxAgeMs) continue;

      try {
        await fs.promises.unlink(path.join(dir, entry));
      } catch {
        // Ignore - file may have been cleaned up already
      }
    }
  } catch {
    // Directory doesn't exist or can't be read - not an error
  }
}

/**
 * Atomically write content to a file using temp + rename pattern.
 * Safe against process crashes and concurrent writes to the same file.
 *
 * How it works:
 * 1. Creates parent directories if they don't exist
 * 2. Writes content to a hidden temp file in the same directory
 * 3. Renames temp file to target (atomic on POSIX systems)
 * 4. Cleans up temp file if any step fails
 */
export async function atomicWriteFile(
  filePath: string,
  content: string | Buffer,
  encoding: BufferEncoding = 'utf-8'
): Promise<void> {
  const dir = path.dirname(filePath);
  const basename = path.basename(filePath);
  const tempPath = path.join(dir, `.${basename}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`);

  await fs.promises.mkdir(dir, { recursive: true });
  await cleanupStaleForFile(dir, basename);

  try {
    await fs.promises.writeFile(tempPath, content, encoding);
    await fs.promises.rename(tempPath, filePath);
  } catch (err) {
    try {
      await fs.promises.unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}
