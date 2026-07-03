/**
 * Sequence-step parameter interpolation.
 * Resolves {{var:name.path.to.field}} and {{timestamp}} tokens inside a
 * command's params before the executor runs it.
 *
 * Whole-string-token rule: if a string param's entire value is exactly one
 * token (e.g. params.right === "{{var:r.body.available}}"), the resolved
 * value's real type is preserved (number/object/boolean/etc). If the token
 * is embedded in a larger string (e.g. "seqkit{{timestamp}}"), the resolved
 * value is coerced with String().
 */

const TOKEN_RE = /\{\{\s*(var:[^}]+|timestamp)\s*\}\}/g;
const WHOLE_TOKEN_RE = /^\{\{\s*(var:[^}]+|timestamp)\s*\}\}$/;

export class InterpolationError extends Error {
  constructor(public token: string, reason: string) {
    super(`Could not resolve template token {{${token}}}: ${reason}`);
  }
}

/**
 * Resolve a single token (without the {{ }} wrapper) against the variable store.
 */
function resolveToken(token: string, store: Record<string, any>, runTimestamp: number): unknown {
  if (token === 'timestamp') {
    return runTimestamp;
  }

  const path = token.slice('var:'.length);
  const parts = path.split('.');
  const varName = parts[0];
  if (!(varName in store)) {
    throw new InterpolationError(token, `no variable named "${varName}" in the run's captured store (use a prior request({ saveAs: "${varName}" }) step)`);
  }

  let current: any = store[varName];
  for (let i = 1; i < parts.length; i++) {
    const key = parts[i];

    // Lazy JSON.parse when descending into a string body field
    if (typeof current === 'string') {
      try {
        current = JSON.parse(current);
      } catch (e: any) {
        throw new InterpolationError(token, `cannot descend into "${key}" - preceding value is a string that is not valid JSON (${e.message})`);
      }
    }

    if (current === undefined || current === null) {
      throw new InterpolationError(token, `path stops at "${parts.slice(0, i).join('.')}" (undefined/null) before reaching "${key}"`);
    }
    current = current[key];
  }

  if (current === undefined) {
    throw new InterpolationError(token, `path "${path}" did not resolve to a value`);
  }
  return current;
}

/**
 * Resolve all tokens in a single string value.
 * Whole-string token -> typed value passthrough.
 * Embedded token(s) -> String-coerced substitution.
 */
function resolveString(value: string, store: Record<string, any>, runTimestamp: number): unknown {
  const wholeMatch = value.match(WHOLE_TOKEN_RE);
  if (wholeMatch) {
    return resolveToken(wholeMatch[1], store, runTimestamp);
  }

  TOKEN_RE.lastIndex = 0;
  if (!TOKEN_RE.test(value)) {
    return value; // no tokens present, fast path
  }
  TOKEN_RE.lastIndex = 0;

  return value.replace(TOKEN_RE, (_match, token) => {
    const resolved = resolveToken(token, store, runTimestamp);
    return typeof resolved === 'object' ? JSON.stringify(resolved) : String(resolved);
  });
}

function walk(value: any, store: Record<string, any>, runTimestamp: number): any {
  if (typeof value === 'string') {
    return resolveString(value, store, runTimestamp);
  }
  if (Array.isArray(value)) {
    return value.map(item => walk(item, store, runTimestamp));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, any> = {};
    for (const key of Object.keys(value)) {
      result[key] = walk(value[key], store, runTimestamp);
    }
    return result;
  }
  return value; // number, boolean, null, undefined pass through unchanged
}

/**
 * Recursively resolve {{var:...}}/{{timestamp}} tokens throughout params.
 * runTimestamp must be computed once per sequence run (not per call) so
 * {{timestamp}} is stable across multiple steps in the same run.
 */
export function interpolateParams(
  params: Record<string, any>,
  store: Record<string, any>,
  runTimestamp: number
): Record<string, any> {
  return walk(params, store, runTimestamp) as Record<string, any>;
}
