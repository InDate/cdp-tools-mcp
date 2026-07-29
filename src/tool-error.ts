/**
 * A tool handler's error response, raised as an exception.
 *
 * `executeToolCall` converts any `isError` response into one of these, so every
 * caller downstream of it sees tool failures as throws. Kept in its own module
 * so tests can construct the real thing: a hand-rolled stand-in drifts from the
 * `response` it carries, and code that classifies failures reads that response
 * (`_errorId` above all).
 */
export class ToolError extends Error {
  constructor(public response: any) {
    super(response?.content?.[0]?.text || 'Tool error');
    this.name = 'ToolError';
  }
}
