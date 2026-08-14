/**
 * The inverse of interpolation.ts: given values a `saveAs` step already
 * captured earlier in the same history, find literal values in a later
 * step's params that came from those captures and rewrite them back to
 * `{{var:name.path}}` tokens - what a person hand-templatizing a recorded
 * sequence does today (see references/sequences.md).
 *
 * Two match shapes, both driven by exact string/number equality (never
 * fuzzy): a param leaf whose ENTIRE value equals a captured value anywhere
 * in its tree, and a captured value appearing as a SUBSTRING inside a larger
 * string leaf (e.g. an id embedded in a CSS selector). The substring case is
 * pattern-matching inside arbitrary text, so it additionally guards against
 * common short values (small numbers, HTTP-status-shaped numbers, booleans)
 * that would otherwise false-positive against unrelated params.
 */

export interface CaptureEntry {
  name: string;
  value: unknown;
}

const MAX_DEPTH = 6;

/** Whole-value match: any string/number, however short - it's an exact
 *  equality on the ENTIRE leaf, not a substring, so the false-positive risk
 *  a length floor exists to prevent doesn't apply here. */
const MIN_WHOLE_STRING_LEN = 1;

/** Substring match: a captured value gets pattern-matched against arbitrary
 *  text, so short/common values need a floor - "2" appearing inside a
 *  string is not evidence it came from a capture. */
const MIN_EMBED_LEN = 4;

/** Numbers common enough by coincidence (HTTP statuses, small counters,
 *  booleans-as-0/1) that matching them proves nothing about provenance. */
const COMMON_NUMBER_BLOCKLIST = new Set([
  0, 1, 2, 3, 4, 5, 10, 100,
  200, 201, 202, 204, 301, 302, 304, 400, 401, 403, 404, 405, 409, 422, 429, 500, 502, 503, 504,
]);

function isSubstitutableNumber(n: number): boolean {
  return Number.isFinite(n) && !COMMON_NUMBER_BLOCKLIST.has(n);
}

/** DFS for a path to a leaf inside `tree` that strictly equals `target`. */
function findPath(tree: unknown, target: string | number, path: string[] = [], depth = 0): string[] | null {
  if (tree === target) return path;
  if (depth >= MAX_DEPTH || tree === null || typeof tree !== 'object') return null;
  for (const key of Object.keys(tree)) {
    const found = findPath((tree as Record<string, unknown>)[key], target, [...path, key], depth + 1);
    if (found) return found;
  }
  return null;
}

function pathToVarToken(name: string, path: string[]): string {
  let out = name;
  for (const seg of path) {
    out += /^[^.[\]]+$/.test(seg) ? `.${seg}` : `['${seg}']`;
  }
  return `{{var:${out}}}`;
}

/** Try a whole-leaf match (the entire param value equals a captured value). */
function matchWhole(value: string | number, captures: CaptureEntry[]): string | null {
  if (typeof value === 'string' && value.length < MIN_WHOLE_STRING_LEN) return null;
  if (typeof value === 'number' && !isSubstitutableNumber(value)) return null;
  for (const capture of captures) {
    const path = findPath(capture.value, value);
    if (path) return pathToVarToken(capture.name, path);
  }
  return null;
}

interface Leaf { path: string[]; str: string }

function collectLeaves(tree: unknown, path: string[] = [], depth = 0, out: Leaf[] = []): Leaf[] {
  if (depth >= MAX_DEPTH || tree === null || tree === undefined) return out;
  if (typeof tree === 'string') {
    if (tree.length >= MIN_EMBED_LEN) out.push({ path, str: tree });
  } else if (typeof tree === 'number') {
    if (isSubstitutableNumber(tree) && String(tree).length >= MIN_EMBED_LEN) out.push({ path, str: String(tree) });
  } else if (typeof tree === 'object') {
    for (const key of Object.keys(tree)) {
      collectLeaves((tree as Record<string, unknown>)[key], [...path, key], depth + 1, out);
    }
  }
  return out;
}

/** Replace every occurrence of a capture's leaf values inside `str`, longest
 *  match first so a longer id doesn't get partially clobbered by a shorter
 *  one nested inside it. */
function substituteEmbedded(str: string, capture: CaptureEntry): string {
  const leaves = collectLeaves(capture.value).sort((a, b) => b.str.length - a.str.length);
  let result = str;
  for (const leaf of leaves) {
    if (result.includes(leaf.str)) {
      result = result.split(leaf.str).join(pathToVarToken(capture.name, leaf.path));
    }
  }
  return result;
}

function walk(value: any, captures: CaptureEntry[]): any {
  if (Array.isArray(value)) return value.map(item => walk(item, captures));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const key of Object.keys(value)) out[key] = walk(value[key], captures);
    return out;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const whole = matchWhole(value, captures);
    if (whole) return whole;
    if (typeof value === 'string') {
      let result = value;
      for (const capture of captures) result = substituteEmbedded(result, capture);
      return result;
    }
  }
  return value;
}

/**
 * Rewrite literal values in `params` that match an earlier `saveAs` capture
 * back into `{{var:name.path}}` references. `captures` must only contain
 * steps that precede this one in the sequence being built.
 */
export function substituteCapturedValues(params: Record<string, any>, captures: CaptureEntry[]): Record<string, any> {
  if (captures.length === 0) return params;
  return walk(params, captures);
}
