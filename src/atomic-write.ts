import * as fs from 'fs';
import * as path from 'path';

/**
 * Atomically write content to a file using temp + rename pattern.
 * Safe against process crashes and concurrent writes to the same file.
 *
 * How it works:
 * 1. Creates parent directories if they don't exist
 * 2. Writes content to a hidden temp file in the same directory
 * 3. Renames temp file to target (atomic on POSIX systems)
 * 4. Cleans up temp file if any step fails
 *
 * This prevents:
 * - Truncated files from process crashes mid-write
 * - Corrupted files from concurrent writes
 *
 * @param filePath - Absolute path to the target file
 * @param content - String or Buffer content to write
 * @param encoding - Character encoding (default: 'utf-8')
 *
 * @example
 * // No need to mkdir before calling - directories are created automatically
 * await atomicWriteFile('/path/to/new/dir/file.json', JSON.stringify(data, null, 2));
 */
export async function atomicWriteFile(
  filePath: string,
  content: string | Buffer,
  encoding: BufferEncoding = 'utf-8'
): Promise<void> {
  const dir = path.dirname(filePath);
  const basename = path.basename(filePath);
  // Use hidden temp file with timestamp and random suffix to avoid collisions
  const tempPath = path.join(dir, `.${basename}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`);

  // Ensure directory exists
  await fs.promises.mkdir(dir, { recursive: true });

  try {
    // Write to temp file
    await fs.promises.writeFile(tempPath, content, encoding);
    // Atomic rename (on POSIX, rename is atomic within same filesystem)
    await fs.promises.rename(tempPath, filePath);
  } catch (err) {
    // Clean up temp file on any error
    try {
      await fs.promises.unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}
