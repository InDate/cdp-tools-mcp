/**
 * Page-parser plugin loader.
 *
 * A parser plugin is a small ES module dropped into `.cdp-tools/parsers/`
 * (project first, then `~/.cdp-tools/parsers/`). It is imported dynamically at
 * call time — so adding or editing a parser needs no rebuild/restart of the
 * server. Each plugin default-exports:
 *
 *   export default {
 *     name: 'ai-overview',
 *     description: 'Google AI Overview summary + cited links',
 *     match: /google\.[a-z.]+\/search/,   // optional: hints it fits the URL
 *     waitFor: () => boolean,             // optional: runs IN the page; the tool
 *                                         //   waits for this to become true
 *     extract: () => any,                 // required: runs IN the page (via
 *                                         //   page.evaluate) and returns JSON
 *   };
 *
 * IMPORTANT: `waitFor` and `extract` are serialized and executed in the browser
 * context, so they must be self-contained — no closures over Node-side scope,
 * no imports. Define any helpers inside the function body.
 */

import { readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { pathToFileURL } from 'url';
import { join } from 'path';
import { getOutputPath } from './paths.js';

export interface ParserPlugin {
  name: string;
  description?: string;
  match?: RegExp;
  /** Runs in the page; the tool waits until it returns true (or waitMs elapses). */
  waitFor?: () => boolean;
  /** Runs in the page via page.evaluate; returns JSON-serializable data. */
  extract: () => unknown;
}

export interface ParserInfo {
  name: string;
  description?: string;
  file: string;
  /** true/false when the plugin declares a `match` and a URL was provided. */
  matches?: boolean;
}

const PLUGIN_EXT = /\.(mjs|cjs|js)$/;

/** Candidate parser directories, project first then global. Existing only. */
function parserDirs(): string[] {
  const candidates = [
    getOutputPath('parsers'),
    getOutputPath('parsers', { global: true }),
  ];
  const dirs: string[] = [];
  for (const d of candidates) {
    if (!dirs.includes(d) && existsSync(d)) dirs.push(d);
  }
  return dirs;
}

export function parserSearchPaths(): string[] {
  // Return intended locations even if they don't exist yet (for messaging).
  const proj = getOutputPath('parsers');
  const global = getOutputPath('parsers', { global: true });
  return proj === global ? [proj] : [proj, global];
}

async function importPlugin(file: string): Promise<ParserPlugin> {
  // Cache-bust so edited plugins reload without restarting the server.
  const url = `${pathToFileURL(file).href}?t=${Date.now()}`;
  const mod = await import(url);
  const plugin = (mod.default ?? mod) as ParserPlugin;
  if (!plugin || typeof plugin.extract !== 'function') {
    throw new Error(`Parser '${file}' must default-export an object with an extract() function`);
  }
  return plugin;
}

async function pluginFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => PLUGIN_EXT.test(f)).map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/** List available plugins (project overrides global on name collision). */
export async function listParsers(url?: string): Promise<ParserInfo[]> {
  const byName = new Map<string, ParserInfo>();
  for (const dir of parserDirs()) {
    for (const file of await pluginFiles(dir)) {
      try {
        const p = await importPlugin(file);
        const name = p.name || file.replace(/^.*\//, '').replace(PLUGIN_EXT, '');
        if (byName.has(name)) continue; // project scanned first wins
        byName.set(name, {
          name,
          description: p.description,
          file,
          matches: url && p.match ? p.match.test(url) : undefined,
        });
      } catch {
        // Skip a broken plugin during listing rather than failing the whole call.
      }
    }
  }
  return [...byName.values()];
}

/** Load a single plugin by name. Throws if not found. */
export async function loadParser(name: string): Promise<ParserPlugin> {
  for (const dir of parserDirs()) {
    for (const file of await pluginFiles(dir)) {
      const p = await importPlugin(file);
      const pname = p.name || file.replace(/^.*\//, '').replace(PLUGIN_EXT, '');
      if (pname === name) return p;
    }
  }
  throw new Error(
    `Parser plugin '${name}' not found. Searched: ${parserSearchPaths().join(', ')}`
  );
}
