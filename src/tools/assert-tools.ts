/**
 * Assert Tool - inline assertions as a sequence step
 * Compares a (typically {{var:...}}-templated) left value against right using
 * operator. On failure, returns isError:true, which the executor's existing
 * abort-on-failure path treats as a hard stop - same semantics as the
 * must()-throw pattern this replaces in hand-written JS blobs.
 */

import { z } from 'zod';
import { createTool } from '../validation-helpers.js';
import { getErrorMessage, getFormattedResponse, createErrorResponse } from '../messages.js';
import { resolveSelector, isExtendedSelector, cleanupResolvedSelector } from '../utils/selector-resolver.js';
import type { ToolResponseMeta } from '../tool-response.js';

const assertSchema = z.object({
  left: z.any().optional().describe('Value to check (typically a {{var:name.path}} template, resolved before this tool runs). Omit when asserting on `selector`'),
  operator: z.enum([
    'equals', 'notEquals',
    'exists', 'notExists',
    'gt', 'gte', 'lt', 'lte',
    'contains', 'matches',
  ]).optional().describe('Comparison operator. Required for the value form, and for the selector conditions that compare something (text/attribute/count)'),
  right: z.any().optional().describe('Value to compare against. Not used for exists/notExists.'),
  message: z.string().optional().describe('Custom failure message'),

  // DOM form: assert about the page instead of a captured value.
  selector: z.string().optional().describe('CSS selector to assert about, polled until it holds or the deadline passes. Supports :has-text("x"). Use this instead of hand-rolling a wait loop in inspect({evaluateExpression})'),
  condition: z.enum(['present', 'visible', 'hittable', 'absent', 'text', 'attribute', 'count', 'enabled'])
    .optional()
    .describe('What to require of `selector`: present (in the DOM) | visible (rendered, non-zero box) | hittable (elementFromPoint at its centre lands inside it - nothing covering it, which is what "a user can click this" actually means) | absent | text (its textContent, with operator/right) | attribute (`attribute` name, with operator/right) | count (how many match, with operator/right) | enabled (not disabled)'),
  attribute: z.string().optional().describe("condition 'attribute': which attribute to read"),
  timeoutMs: z.number().optional().describe('How long to keep polling the selector before failing (default 5000). Kept below the evaluation timeout so a failure reports what it actually found rather than dying as "did not respond"'),
  connectionReason: z.string().optional().describe('Which browser to look at. Injected from the run for sequence steps; ignored by the value form'),
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
    default:
      return { passed: false, detail: 'no operator given' };
  }
}

/**
 * Poll a selector until its condition holds, then report - or fail saying what
 * the page actually showed.
 *
 * The deadline belongs to the harness rather than to whoever wrote the step: a
 * hand-rolled poll that outlives the evaluation timeout dies as "did not
 * respond" and takes its diagnostic with it, which is silent and unrecoverable.
 */
async function assertDom(
  args: AssertArgs,
  resolveConnectionFromReason?: (connectionReason: string) => Promise<any>
): Promise<any> {
  const { selector: rawSelector, condition, operator, right, message, attribute } = args;
  const timeoutMs = args.timeoutMs ?? 5000;

  if (!resolveConnectionFromReason || !args.connectionReason) {
    return {
      content: [{ type: 'text', text: `## Error\n\nNo browser connection for a DOM assertion\n\n**Suggestion:** \`selector\` asserts about a page, so this needs a connection. In a sequence the run's connection is injected automatically; called directly, pass \`connectionReason\`.` }],
      isError: true,
    };
  }
  const resolved = await resolveConnectionFromReason(args.connectionReason);
  if (!resolved) {
    return createErrorResponse('CONNECTION_NOT_FOUND', {
      message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
    });
  }
  const page = resolved.puppeteerManager?.getPage();
  if (!page) {
    return createErrorResponse('CONNECTION_NOT_FOUND', { message: 'That connection has no page attached.' });
  }
  const comparing = condition === 'text' || condition === 'attribute' || condition === 'count';
  if (comparing && !operator) {
    return {
      content: [{ type: 'text', text: `## Error\n\nCondition \`${condition}\` compares a value, so it needs \`operator\` (and usually \`right\`)` }],
      isError: true,
    };
  }
  if (condition === 'attribute' && !attribute) {
    return {
      content: [{ type: 'text', text: '## Error\n\nCondition `attribute` needs `attribute` naming which one to read' }],
      isError: true,
    };
  }

  const deadline = Date.now() + timeoutMs;
  let probe: DomProbe | undefined;
  let detail: string | undefined;
  let passed = false;

  const NO_MATCH: DomProbe = { count: 0, visible: false, hittable: false, text: null, attribute: null, enabled: false, coveredBy: null };

  while (true) {
    let selector = rawSelector!;
    let resolvedExtended = false;
    let matched = true;
    if (isExtendedSelector(selector)) {
      const r = await resolveSelector(page, selector);
      // An extended selector reports "no match" as an error. That is a fact
      // about the page, not a broken step - and for `absent` it is the fact
      // being asserted, so it has to reach the condition below rather than
      // short-circuit into a retry that can only ever time out.
      if ('error' in r) matched = false;
      else { selector = r.selector; resolvedExtended = true; }
    }
    if (matched) {
      probe = await probeDom(page, selector, attribute);
      if (resolvedExtended) await cleanupResolvedSelector(page, selector);
    } else {
      probe = NO_MATCH;
    }

    switch (condition) {
      case 'present': passed = probe.count > 0; break;
      case 'absent': passed = probe.count === 0; break;
      case 'visible': passed = probe.visible; break;
      case 'hittable': passed = probe.hittable; break;
      case 'enabled': passed = probe.count > 0 && probe.enabled; break;
      case 'count': ({ passed, detail } = evaluate(probe.count, operator!, right)); break;
      case 'text':
        ({ passed, detail } = probe.count === 0 ? { passed: false, detail: 'no element matched' } : evaluate(probe.text, operator!, right));
        break;
      case 'attribute':
        ({ passed, detail } = probe.count === 0 ? { passed: false, detail: 'no element matched' } : evaluate(probe.attribute, operator!, right));
        break;
    }
    if (passed || Date.now() >= deadline) break;
    await new Promise(r => setTimeout(r, 250));
  }

  const assertMeta: ToolResponseMeta = {
    tool: 'assert',
    action: `${condition}`,
    timestamp: Date.now(),
    assert: { left: rawSelector, operator: condition!, right, passed },
  };

  if (passed) {
    return {
      content: [{ type: 'text', text: `Assertion passed: \`${rawSelector}\` ${condition}${comparing ? ` ${operator} ${JSON.stringify(right)}` : ''}` }],
      _meta: assertMeta,
    };
  }

  // Say what was there instead. "Covered by" is the whole point of `hittable`:
  // present and painted, yet unreachable.
  const found: string[] = [`matched ${probe?.count ?? 0}`];
  if (probe && probe.count > 0) {
    found.push(`visible=${probe.visible}`, `hittable=${probe.hittable}`);
    if (probe.coveredBy) found.push(`covered by ${probe.coveredBy}`);
    if (condition === 'text') found.push(`text=${JSON.stringify((probe.text || '').slice(0, 60))}`);
    if (condition === 'attribute') found.push(`${attribute}=${JSON.stringify(probe.attribute)}`);
    if (condition === 'enabled') found.push(`enabled=${probe.enabled}`);
  }
  const why = detail ? `${detail}. ` : '';
  return {
    content: [{
      type: 'text',
      text: `## Assertion failed\n\n${message || `\`${rawSelector}\` was not ${condition}${comparing ? ` ${operator} ${JSON.stringify(right)}` : ''} within ${timeoutMs}ms`}\n\n${why}**Found:** ${found.join(', ')}`,
    }],
    isError: true,
    _meta: assertMeta,
  };
}

/** What one poll of the page saw for a selector. */
interface DomProbe {
  count: number;
  visible: boolean;
  hittable: boolean;
  text: string | null;
  attribute: string | null;
  enabled: boolean;
  /** What hit-testing returned instead, when the element is covered. */
  coveredBy: string | null;
}

/**
 * Read everything the DOM conditions need in one pass, so a poll is one round
 * trip and every fact describes the same moment.
 */
async function probeDom(page: any, selector: string, attribute?: string): Promise<DomProbe> {
  return await page.evaluate((sel: string, attr: string | null) => {
    const doc = (globalThis as any).document;
    const all = [...doc.querySelectorAll(sel)];
    const el: any = all[0];
    if (!el) {
      return { count: 0, visible: false, hittable: false, text: null, attribute: null, enabled: false, coveredBy: null };
    }
    // Bring it into view first, as `input` does. Otherwise hit-testing an
    // element below the fold returns null and reads as unreachable, when a user
    // would simply scroll to it.
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    const style = (globalThis as any).getComputedStyle(el);
    const visible = r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
    // Hit-testing is the difference between "rendered" and "reachable": an
    // element can be laid out and painted while another sits on top of it.
    const hit = visible ? doc.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) : null;
    const hittable = !!hit && (hit === el || el.contains(hit));
    const describe = (n: any) => n
      ? `${n.tagName.toLowerCase()}${n.getAttribute?.('aria-label') ? `[${n.getAttribute('aria-label')}]` : ''}: ${(n.textContent || '').trim().slice(0, 40)}`
      : null;
    return {
      count: all.length,
      visible,
      hittable,
      text: (el.textContent || '').trim(),
      attribute: attr ? el.getAttribute(attr) : null,
      enabled: !el.disabled && el.getAttribute('aria-disabled') !== 'true',
      coveredBy: hittable ? null : describe(hit),
    };
  }, selector, attribute ?? null);
}

export function createAssertTools(
  resolveConnectionFromReason?: (connectionReason: string) => Promise<any>
) {
  return {
    assert: createTool(
      'Assert a condition as a sequence step. Fails the sequence (isError, executor stops) if the condition is false. Two forms: a VALUE check against {{var:name.path}} templates captured by a prior request({saveAs}) or inspect({saveAs}) step; or a DOM check via `selector` + `condition`, which polls the page until it holds and reports what it actually found - use that instead of hand-writing a wait loop inside inspect({evaluateExpression}), which invites acting on the page from the same step.',
      assertSchema,
      async (args: AssertArgs) => {
        if (args.selector && args.condition) {
          return await assertDom(args, resolveConnectionFromReason);
        }
        const { left, operator, right, message } = args;
        if (!operator) {
          return {
            content: [{ type: 'text', text: '## Error\n\nMissing `operator`\n\n**Suggestion:** the value form needs `left` + `operator`; the DOM form needs `selector` + `condition`.' }],
            isError: true,
          };
        }
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
