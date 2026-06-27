/**
 * Plugin tools — STUB.
 *
 * The real implementation exposed MCP tools over the log-processor Orchestrator
 * (managing/querying the classifier / extractor / state-machine plugins). It was
 * never committed; `index.ts` spreads `createPluginTools(() => orchestrator)` into
 * the tool registry. This stub returns no tools so the project builds and runs
 * with the feature inert. Replace to restore the plugin tools.
 */

import type { Orchestrator } from '../log-processor/orchestrator.js';

/**
 * Build the log-processor plugin tools. The argument is a getter for the live
 * Orchestrator (null until the session becomes the dashboard hub).
 */
export function createPluginTools(
  _getOrchestrator: () => Orchestrator | null
): Record<string, never> {
  return {};
}
