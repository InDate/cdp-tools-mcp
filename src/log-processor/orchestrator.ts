/**
 * Log-processor Orchestrator — STUB.
 *
 * The real implementation was never committed to the repo: post-v0.4.1 commits
 * wired it into `index.ts` (and the dashboard hub) but the `src/log-processor/`
 * directory and `src/tools/plugin-tools.ts` were never `git add`ed. This stub
 * reproduces the *interface* inferred from those call sites so the project builds
 * and runs with the log-processor feature inert. Replace with the real engine —
 * a config-driven pipeline of classifiers / extractors / state-machines over live
 * MCP session logs, loaded from `.devharness/config/{classifiers,extractors,
 * state-machines,dashboard}/` — to restore it.
 */

import type { SessionDetector } from '../session-detector.js';

export interface OrchestratorSource {
  /** Where logs come from. Only 'live' (via a SessionDetector) is wired today. */
  mode: 'live';
  sessionDetector: SessionDetector;
}

export interface OrchestratorOptions {
  source: OrchestratorSource;
  /** Root config dir (`.devharness/config`) holding the plugin subdirectories. */
  configDir: string;
}

export class Orchestrator {
  constructor(private readonly options: OrchestratorOptions) {}

  /** Begin processing logs from the configured source. No-op in the stub. */
  async start(): Promise<void> {
    // intentionally inert — see file header
  }

  /** Stop processing. No-op in the stub. */
  stop(): void {
    // intentionally inert — see file header
  }
}
