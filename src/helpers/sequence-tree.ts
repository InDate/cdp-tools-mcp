/**
 * Sequence folder support.
 *
 * Sequences used to live in one flat directory. A suite of any size wants
 * grouping (spine/, story/, _helpers/), so the on-disk scan recurses and every
 * filename it reports stays RELATIVE to the sequences root ('spine/spine-01.json').
 * That relative form is what `load` accepts back, so a file keeps working when it
 * moves into a folder.
 */
import { promises as fs } from 'fs';
import { join } from 'path';

/** Folders whose name starts with '_' hold sequences that only make sense when
 *  another sequence calls them by name — preamble guards, forEach bodies. They
 *  are always LOADED (so those name references resolve) but never run on their
 *  own, where they would fail on unbound variables or an unmet precondition. */
export const HELPER_FOLDER_PREFIX = '_';

/**
 * Every .json file under `dir`, recursively, as paths relative to `dir`, sorted.
 * Returns [] when the directory does not exist — an absent sequences dir is a
 * normal state, not an error.
 */
export async function walkSequenceFiles(dir: string): Promise<string[]> {
  const walk = async (rel: string): Promise<string[]> => {
    let entries;
    try {
      entries = await fs.readdir(join(dir, rel), { withFileTypes: true });
    } catch (err: any) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const out: string[] = [];
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) out.push(...await walk(child));
      else if (entry.name.endsWith('.json')) out.push(child);
    }
    return out;
  };
  return (await walk('')).sort();
}

/** True when any folder segment of a relative path is a helper folder. */
export function isHelperPath(filename: string): boolean {
  return filename.split('/').slice(0, -1).some(seg => seg.startsWith(HELPER_FOLDER_PREFIX));
}

/**
 * Which sequences a `runAll` should execute.
 *
 * With a folder: everything beneath it (helper folders nested inside are still
 * skipped — asking for spine/ should not run spine/_helpers/). Without one:
 * every sequence except those in helper folders.
 *
 * Selection is deliberately separate from loading: the caller loads the whole
 * tree first so cross-folder name references resolve, then runs only this.
 */
export function selectSuiteFiles(filenames: string[], folder?: string): string[] {
  const scope = (folder || '').replace(/^\/+|\/+$/g, '');
  // Naming a helper folder explicitly is a deliberate act — honour it. The
  // skip only applies when the caller did NOT ask for it, which is what makes
  // a bare runAll leave preamble sequences alone.
  const scopeIsHelper = scope !== '' && isHelperPath(`${scope}/x.json`);
  return filenames
    .filter(f => {
      if (!scope) return !isHelperPath(f);
      const inScope = f === `${scope}.json` || f.startsWith(`${scope}/`);
      if (!inScope) return false;
      // Within a requested non-helper folder, still skip nested helper folders.
      return scopeIsHelper ? true : !isHelperPath(f);
    })
    .sort((a, b) => a.localeCompare(b));
}

/** Distinct folder paths present in a set of relative filenames. */
export function sequenceFolders(filenames: string[]): string[] {
  return [...new Set(
    filenames.map(f => f.split('/').slice(0, -1).join('/')).filter(Boolean)
  )].sort();
}
