/**
 * Zod Validation Helpers
 * Provides utilities for validating tool parameters with Zod schemas
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { randomUUID } from 'crypto';

/**
 * Result of parameter validation
 */
export type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; error: any };

/**
 * Pending calls that failed only because required parameters were missing.
 * Caller can retry with { continuationToken, <missing fields> } instead of
 * resending the whole argument set.
 */
interface PendingContinuation {
  toolName: string;
  args: Record<string, unknown>;
  expiresAt: number;
}

const CONTINUATION_TTL_MS = 5 * 60 * 1000;
const pendingContinuations = new Map<string, PendingContinuation>();

function sweepExpiredContinuations(): void {
  const now = Date.now();
  for (const [token, entry] of pendingContinuations) {
    if (entry.expiresAt < now) pendingContinuations.delete(token);
  }
}

function isMissingRequiredIssue(issue: z.ZodIssue): boolean {
  return issue.code === 'invalid_type' && issue.received === 'undefined';
}

/**
 * Unwraps optional/default/nullable wrappers to get at the underlying type
 * for describing enums, etc.
 */
function unwrapZodType(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current: z.ZodTypeAny = schema;
  while (
    current instanceof z.ZodOptional ||
    current instanceof z.ZodNullable ||
    current instanceof z.ZodDefault
  ) {
    current = current instanceof z.ZodDefault ? current._def.innerType : current.unwrap();
  }
  return current;
}

interface MissingParamInfo {
  name: string;
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
}

/**
 * Best-effort lookup of a field's Zod definition to describe what's expected.
 * Only handles flat/dotted top-level object fields; falls back to a bare
 * shape if the schema isn't a ZodObject or the path can't be resolved.
 */
function describeMissingField(schema: z.ZodTypeAny, fieldPath: string): MissingParamInfo {
  const info: MissingParamInfo = { name: fieldPath, type: 'unknown' };

  let currentSchema: z.ZodTypeAny | undefined = schema;
  let fieldSchema: z.ZodTypeAny | undefined;

  for (const part of fieldPath.split('.')) {
    if (!(currentSchema instanceof z.ZodObject)) {
      fieldSchema = undefined;
      break;
    }
    fieldSchema = currentSchema.shape[part];
    currentSchema = fieldSchema;
  }

  if (!fieldSchema) return info;

  info.description = (fieldSchema as any)._def?.description;

  if (fieldSchema instanceof z.ZodDefault) {
    try {
      info.default = fieldSchema._def.defaultValue();
    } catch {
      // ignore
    }
  }

  const unwrapped = unwrapZodType(fieldSchema);

  if (unwrapped instanceof z.ZodEnum) {
    info.type = 'enum';
    info.enum = unwrapped.options;
  } else if (unwrapped instanceof z.ZodString) {
    info.type = 'string';
  } else if (unwrapped instanceof z.ZodNumber) {
    info.type = 'number';
  } else if (unwrapped instanceof z.ZodBoolean) {
    info.type = 'boolean';
  } else if (unwrapped instanceof z.ZodArray) {
    info.type = 'array';
  } else if (unwrapped instanceof z.ZodObject) {
    info.type = 'object';
  } else {
    info.type = (unwrapped as any)._def?.typeName || 'unknown';
  }

  return info;
}

/**
 * Validates parameters against a Zod schema
 * Returns validated data or formatted error response
 *
 * Supports an out-of-band `continuationToken` param: if a prior call to the
 * same tool failed with missing required params, the caller can retry with
 * just { continuationToken, <missing fields> } and this merges it with the
 * originally-supplied args instead of requiring a full resend.
 */
export function validateParams<T extends z.ZodTypeAny>(
  params: unknown,
  schema: T,
  toolName: string
): ValidationResult<z.infer<T>> {
  sweepExpiredContinuations();

  let effectiveParams: unknown = params;
  let continuationToken: string | undefined;

  if (params && typeof params === 'object' && 'continuationToken' in (params as Record<string, unknown>)) {
    const { continuationToken: token, ...rest } = params as Record<string, unknown>;
    if (typeof token === 'string') {
      continuationToken = token;
      const pending = pendingContinuations.get(token);
      effectiveParams = pending && pending.toolName === toolName
        ? { ...pending.args, ...rest }
        : rest;
    } else {
      effectiveParams = rest;
    }
  }

  const result = schema.safeParse(effectiveParams);

  if (!result.success) {
    const missingIssues = result.error.issues.filter(isMissingRequiredIssue);
    const otherIssues = result.error.issues.filter(issue => !isMissingRequiredIssue(issue));

    // Any failure keeps (or opens) a continuation slot with the latest attempt's
    // args, so the caller can retry with just a fix/addition rather than the
    // whole payload - whether the problem was a missing field or a bad value.
    const token = continuationToken && pendingContinuations.has(continuationToken)
      ? continuationToken
      : randomUUID();

    pendingContinuations.set(token, {
      toolName,
      args: effectiveParams as Record<string, unknown>,
      expiresAt: Date.now() + CONTINUATION_TTL_MS
    });

    const instructions = `Call '${toolName}' again with { continuationToken: '${token}', ...<only the field(s) to add/fix> }. Previously supplied arguments are cached for ${Math.round(CONTINUATION_TTL_MS / 60000)} minutes and merged automatically - no need to resend them.`;

    if (missingIssues.length > 0) {
      const missingParameters = missingIssues.map(issue =>
        describeMissingField(schema, issue.path.join('.'))
      );

      const error: Record<string, unknown> = {
        success: false,
        error: `Missing required parameter(s) for tool '${toolName}'`,
        code: otherIssues.length > 0 ? 'INVALID_PARAMS' : 'MISSING_PARAMETERS',
        missingParameters,
        continuationToken: token,
        instructions
      };

      if (otherIssues.length > 0) {
        error.validationErrors = formatZodErrors(result.error, otherIssues);
      }

      return { success: false, error };
    }

    // Only non-missing issues (bad types/enums/etc on values actually supplied)
    return {
      success: false,
      error: {
        success: false,
        error: `Invalid parameters for tool '${toolName}'`,
        code: 'INVALID_PARAMS',
        validationErrors: formatZodErrors(result.error),
        continuationToken: token,
        instructions
      }
    };
  }

  // Validation succeeded - the token's job (merging args) is done. Resuming a
  // call that's blocked *after* this point by an unrelated guard (port
  // failure, dead server, etc.) is already handled by the existing command
  // recorder / replay({ action: 'repeat' }) mechanism, which records this same
  // merged `result.data` right after this call returns - no need to keep the
  // continuation cache alive for that case too.
  if (continuationToken) pendingContinuations.delete(continuationToken);

  return { success: true, data: result.data };
}

/**
 * Converts Zod validation errors to user-friendly messages
 */
function formatZodErrors(error: z.ZodError, issues: z.ZodIssue[] = error.issues): string[] {
  return issues.map(issue => {
    const path = issue.path.length > 0 ? issue.path.join('.') : 'root';

    switch (issue.code) {
      case 'invalid_type':
        if (issue.received === 'undefined') {
          return `Missing required parameter: ${path}`;
        }
        return `Parameter '${path}' must be ${issue.expected}, got ${issue.received}`;

      case 'unrecognized_keys':
        return `Unknown parameter(s): ${issue.keys.join(', ')}`;

      case 'too_small':
        if (issue.type === 'string') {
          return `Parameter '${path}' must be at least ${issue.minimum} characters`;
        } else if (issue.type === 'number') {
          return `Parameter '${path}' must be at least ${issue.minimum}`;
        } else if (issue.type === 'array') {
          return `Parameter '${path}' must contain at least ${issue.minimum} items`;
        }
        return `Parameter '${path}' is too small`;

      case 'too_big':
        if (issue.type === 'string') {
          return `Parameter '${path}' must be at most ${issue.maximum} characters`;
        } else if (issue.type === 'number') {
          return `Parameter '${path}' must be at most ${issue.maximum}`;
        } else if (issue.type === 'array') {
          return `Parameter '${path}' must contain at most ${issue.maximum} items`;
        }
        return `Parameter '${path}' is too big`;

      case 'invalid_enum_value':
        return `Parameter '${path}' must be one of: ${issue.options.join(', ')}`;

      case 'invalid_string':
        if (issue.validation === 'email') {
          return `Parameter '${path}' must be a valid email address`;
        } else if (issue.validation === 'url') {
          return `Parameter '${path}' must be a valid URL`;
        } else if (issue.validation === 'regex') {
          return `Parameter '${path}' does not match required pattern`;
        }
        return `Parameter '${path}' is invalid`;

      default:
        return issue.message || `Parameter '${path}' is invalid`;
    }
  });
}

/**
 * Helper to create tool definitions with Zod schemas
 * Automatically generates JSON Schema for MCP ListTools response
 */
export function createTool<T extends z.ZodTypeAny>(
  description: string,
  zodSchema: T,
  handler: (args: z.infer<T>, abortSignal?: AbortSignal) => Promise<any>
) {
  return {
    description,
    zodSchema,
    inputSchema: zodToJsonSchema(zodSchema, {
      $refStrategy: 'none', // Inline all schemas for compatibility
      target: 'jsonSchema7',
      strictUnions: true
    }),
    handler
  };
}
