/**
 * Request Tools - HTTP requests as a sequence step
 * destination "node" sends directly from the MCP server process (no browser).
 * destination "browser" runs fetch() inside a connected tab (shares its cookies/session/origin).
 */

import { z } from 'zod';
import { createTool } from '../validation-helpers.js';
import { createSuccessResponse, createErrorResponse } from '../messages.js';

const MAX_RESPONSE_BODY_CHARS = 100_000;

const requestSchema = z.object({
  url: z.string().describe('URL to request'),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).optional().default('GET'),
  headers: z.record(z.string()).optional().describe('Request headers'),
  body: z.string().optional().describe('Raw request body (e.g. JSON.stringify it yourself)'),
  destination: z.enum(['browser', 'node']).describe('browser: fetch inside the connected tab (shares cookies/session/origin). node: fetch directly from the MCP server process'),
  connectionReason: z.string().optional().describe('Required when destination is "browser" - which tab runs the fetch'),
  timeoutMs: z.number().optional().describe('Request timeout in ms (default 30000)'),
}).strict();

type RequestArgs = z.infer<typeof requestSchema>;

interface RawResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

export function createRequestTools(resolveConnectionFromReason: (connectionReason: string) => Promise<any>) {
  return {
    request: createTool(
      'Make an HTTP request as a sequence step. destination "node" sends it from the MCP server process directly (no browser, no CORS/cookies). destination "browser" runs fetch() inside a connected tab (uses that page\'s cookies/session/origin).',
      requestSchema,
      async (args: RequestArgs) => {
        const timeoutMs = args.timeoutMs ?? 30000;
        const startedAt = Date.now();

        if (args.destination === 'browser') {
          if (!args.connectionReason) {
            return createErrorResponse('MISSING_PARAMETER', {
              action: 'request',
              missing: 'connectionReason',
              message: 'destination "browser" requires connectionReason to identify which tab runs the fetch'
            });
          }

          const resolved = await resolveConnectionFromReason(args.connectionReason);
          if (!resolved?.puppeteerManager) {
            return createErrorResponse('CONNECTION_NOT_FOUND', {
              message: `No active browser connection "${args.connectionReason}". Use launchChrome first.`
            });
          }

          try {
            const page = resolved.puppeteerManager.getPage();
            const result: RawResponse = await page.evaluate(
              async (url: string, method: string, headers: Record<string, string> | undefined, body: string | undefined, timeout: number) => {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), timeout);
                try {
                  const res = await fetch(url, { method, headers, body, signal: controller.signal });
                  const text = await res.text();
                  const responseHeaders: Record<string, string> = {};
                  res.headers.forEach((value, key) => { responseHeaders[key] = value; });
                  return { ok: res.ok, status: res.status, statusText: res.statusText, headers: responseHeaders, body: text };
                } finally {
                  clearTimeout(timer);
                }
              },
              args.url, args.method!, args.headers, args.body, timeoutMs
            );
            return formatRequestResult(args, result, Date.now() - startedAt, 'browser');
          } catch (error: any) {
            return createErrorResponse('REQUEST_FAILED', {
              url: args.url,
              destination: 'browser',
              error: error.message || String(error)
            });
          }
        }

        // destination === 'node'
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetch(args.url, {
            method: args.method,
            headers: args.headers,
            body: args.body,
            signal: controller.signal,
          });
          const text = await res.text();
          const responseHeaders: Record<string, string> = {};
          res.headers.forEach((value, key) => { responseHeaders[key] = value; });
          return formatRequestResult(
            args,
            { ok: res.ok, status: res.status, statusText: res.statusText, headers: responseHeaders, body: text },
            Date.now() - startedAt,
            'node'
          );
        } catch (error: any) {
          return createErrorResponse('REQUEST_FAILED', {
            url: args.url,
            destination: 'node',
            error: error.name === 'AbortError' ? `Timed out after ${timeoutMs}ms` : (error.message || String(error))
          });
        } finally {
          clearTimeout(timer);
        }
      }
    ),
  };
}

/**
 * HTTP-level status (4xx/5xx) is not a tool error - curl-style, the request
 * completed, so the caller inspects `status`/`ok` itself. Only network-level
 * failures (unreachable, timeout, abort) are tool errors.
 */
function formatRequestResult(
  args: RequestArgs,
  result: RawResponse,
  durationMs: number,
  destination: 'browser' | 'node'
) {
  const truncated = result.body.length > MAX_RESPONSE_BODY_CHARS;
  const body = truncated ? result.body.slice(0, MAX_RESPONSE_BODY_CHARS) : result.body;

  return createSuccessResponse('REQUEST_SUCCESS', {
    url: args.url,
    method: args.method,
    destination,
    ok: result.ok ? 'yes' : 'no',
    status: result.status.toString(),
    statusText: result.statusText,
    durationMs: durationMs.toString(),
    body,
    truncated: truncated ? 'yes' : 'no',
  }, {
    ok: result.ok,
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
    body,
    durationMs,
  });
}
