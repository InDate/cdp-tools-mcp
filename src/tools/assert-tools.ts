/**
 * Assert Tool - inline assertions as a sequence step
 * Compares a (typically {{var:...}}-templated) left value against right using
 * operator. On failure, returns isError:true, which the executor's existing
 * abort-on-failure path treats as a hard stop - same semantics as the
 * must()-throw pattern this replaces in hand-written JS blobs.
 */

import { z } from 'zod';
import { createTool } from '../validation-helpers.js';
import { getErrorMessage, getFormattedResponse } from '../messages.js';
import type { ToolResponseMeta } from '../tool-response.js';

const assertSchema = z.object({
  left: z.any().describe('Value to check (typically a {{var:name.path}} template, resolved before this tool runs)'),
  operator: z.enum([
    'equals', 'notEquals',
    'exists', 'notExists',
    'gt', 'gte', 'lt', 'lte',
    'contains', 'matches',
  ]).describe('Comparison operator'),
  right: z.any().optional().describe('Value to compare against. Not used for exists/notExists.'),
  message: z.string().optional().describe('Custom failure message'),
}).strict();

type AssertArgs = z.infer<typeof assertSchema>;

/**
 * Coerce both sides to Number for ordering comparisons if both look numeric -
 * avoids string-comparison surprises ("10" < "9") when values arrive as
 * strings (e.g. captured header values, or numbers that round-tripped through
 * JSON as strings).
 */
function toComparable(value: unknown): unknown {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '' && !isNaN(Number(value))) {
    return Number(value);
  }
  return value;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function evaluate(left: unknown, operator: AssertArgs['operator'], right: unknown): { passed: boolean; detail?: string } {
  switch (operator) {
    case 'exists':
      return { passed: left !== undefined && left !== null };
    case 'notExists':
      return { passed: left === undefined || left === null };
    case 'equals':
      return { passed: deepEqual(left, right) };
    case 'notEquals':
      return { passed: !deepEqual(left, right) };
    case 'contains': {
      if (typeof left === 'string') return { passed: left.includes(String(right)) };
      if (Array.isArray(left)) return { passed: left.some(item => deepEqual(item, right)) };
      return { passed: false, detail: `left is ${typeof left}, expected string or array for "contains"` };
    }
    case 'matches': {
      try {
        return { passed: new RegExp(String(right)).test(String(left)) };
      } catch (e: any) {
        return { passed: false, detail: `invalid regex: ${e.message}` };
      }
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const l = toComparable(left);
      const r = toComparable(right);
      let cmp: boolean;
      if (typeof l === 'number' && typeof r === 'number') {
        cmp = operator === 'gt' ? l > r : operator === 'gte' ? l >= r : operator === 'lt' ? l < r : l <= r;
      } else if (typeof l === 'string' && typeof r === 'string') {
        cmp = operator === 'gt' ? l > r : operator === 'gte' ? l >= r : operator === 'lt' ? l < r : l <= r;
      } else {
        return { passed: false, detail: `cannot compare ${JSON.stringify(left)} ${operator} ${JSON.stringify(right)} (mismatched/unsupported types)` };
      }
      return { passed: cmp };
    }
  }
}

export function createAssertTools() {
  return {
    assert: createTool(
      'Assert a condition as a sequence step. Fails the sequence (isError, executor stops) if the condition is false - use with {{var:name.path}} templates to check values captured by a prior request({saveAs}) step.',
      assertSchema,
      async (args: AssertArgs) => {
        const { left, operator, right, message } = args;
        const { passed, detail } = evaluate(left, operator, right);

        const assertMeta: ToolResponseMeta = {
          tool: 'assert',
          action: operator,
          timestamp: Date.now(),
          assert: { left, operator, right, passed },
        };

        if (!passed) {
          const defaultMsg = detail || `expected ${JSON.stringify(left)} ${operator} ${JSON.stringify(right)}`;
          return {
            content: [
              {
                type: 'text',
                text: getErrorMessage('ASSERT_FAILED', {
                  message: message || defaultMsg,
                  left: JSON.stringify(left),
                  operator,
                  right: JSON.stringify(right),
                }),
              },
            ],
            isError: true,
            _meta: assertMeta,
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: getFormattedResponse('ASSERT_SUCCESS', {
                left: JSON.stringify(left),
                operator,
                right: JSON.stringify(right),
              }),
            },
          ],
          _meta: assertMeta,
        };
      }
    ),
  };
}
