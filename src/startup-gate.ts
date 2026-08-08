/**
 * Startup gate: holds tool calls until state recovery has finished.
 *
 * The MCP transport starts serving before serverManager.initialize() has
 * restored managed servers, monitored ports and pending startup failures. A
 * call answered in that window sees an empty world: a dead server's guard finds
 * nothing to block on, and an `acknowledgeStartup` there acknowledges a failure
 * that has not been restored yet - so the block reappears the moment it is, and
 * the acknowledgement looks like it silently unstuck itself.
 *
 * Capped rather than unbounded: recovery pings ports and Docker, and a hung
 * check must not wedge every tool for the rest of the session. Past the cap
 * tools run ungated, which is the pre-gate behaviour, not a new failure mode.
 */

export interface StartupGate {
  /** Resolves once recovery is done, or once the cap expires. */
  wait(): Promise<void>;
  /** Recovery finished (call from a `finally` - a throw must not wedge tools). */
  markComplete(): void;
  /** Whether the gate is still holding calls. */
  isPending(): boolean;
}

export interface StartupGateOptions {
  timeoutMs: number;
  /** Called when the cap expires before recovery reported in. */
  onTimeout?: (timeoutMs: number) => void;
}

export function createStartupGate(options: StartupGateOptions): StartupGate {
  const { timeoutMs, onTimeout } = options;

  let complete = false;
  let release: (() => void) | undefined;
  const recovered = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    isPending: () => !complete,

    markComplete(): void {
      if (complete) return;
      complete = true;
      release?.();
    },

    async wait(): Promise<void> {
      // The common case is every call after the first few: no timer, no await.
      if (complete) return;

      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        recovered,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            onTimeout?.(timeoutMs);
            resolve();
          }, timeoutMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
    },
  };
}
