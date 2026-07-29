import { ToolError } from '../tool-error.js';

/**
 * Make a test's fake `executeToolCall` behave the way the real one does: an
 * `isError` response is RAISED as a ToolError, never returned.
 *
 * Harnesses that returned those responses instead are how a selector condition
 * shipped broken with green tests - the code branched on `result.isError`,
 * which is a shape production cannot produce, so the branch that actually runs
 * was never exercised. Wrap every fake with this.
 */
export function productionShaped<T extends (...args: any[]) => Promise<any>>(fn: T): T {
  return (async (...args: any[]) => {
    const response = await fn(...args);
    if (response?.isError) throw new ToolError(response);
    return response;
  }) as T;
}
