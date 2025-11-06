/**
 * Zod Validation Helpers
 * Provides utilities for validating tool parameters with Zod schemas
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * Result of parameter validation
 */
export type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; error: any };

/**
 * Validates parameters against a Zod schema
 * Returns validated data or formatted error response
 */
export function validateParams<T extends z.ZodTypeAny>(
  params: unknown,
  schema: T,
  toolName: string
): ValidationResult<z.infer<T>> {
  const result = schema.safeParse(params);

  if (!result.success) {
    return {
      success: false,
      error: {
        success: false,
        error: `Invalid parameters for tool '${toolName}'`,
        code: 'INVALID_PARAMS',
        validationErrors: formatZodErrors(result.error),
        suggestions: [
          'Check tool documentation for required parameters',
          'Verify parameter types match expected types',
          'Remove any unknown parameters'
        ],
        details: result.error.format()
      }
    };
  }

  return { success: true, data: result.data };
}

/**
 * Converts Zod validation errors to user-friendly messages
 */
function formatZodErrors(error: z.ZodError): string[] {
  return error.issues.map(issue => {
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
  handler: (args: z.infer<T>) => Promise<any>
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
