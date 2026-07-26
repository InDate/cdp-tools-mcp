/**
 * Abort utilities (#110) - the shared vocabulary for cancellation.
 *
 * Handlers that observe an AbortSignal THROW an abort-shaped error (never
 * return an isError response); callers classify with isAbortError. linkSignals
 * is hand-rolled instead of AbortSignal.any because (a) `engines` allows Node
 * >=18.0.0 and AbortSignal.any needs 18.17/20.3, and (b) AbortSignal.any can
 * never detach its listeners - this code links against a long-lived run
 * signal once per step, so dispose() in a `finally` is mandatory to keep a
 * 500-step run from accumulating hundreds of dead listeners.
 */

/** Error thrown when an operation is cancelled via an AbortSignal. */
export class AbortError extends Error {
  readonly code = 'ABORTED';
  constructor(message = 'Operation aborted', public readonly reason?: unknown) {
    super(message);
    this.name = 'AbortError';
  }
}

/**
 * Whether an error means "cancelled" rather than "failed".
 *
 * Matches by name, not instanceof, because aborts arrive in several shapes:
 * our own AbortError class, the DOMException fetch throws (NOT instanceof
 * Error in every runtime), and whatever `signal.throwIfAborted()` rethrows
 * (the signal's reason - a DOMException by default, anything the aborter
 * passed otherwise). Getting this wrong turns a user's cancel into a
 * "genuine failure" with diagnostics gathered against a browser they just
 * tore down.
 */
export function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'AbortError'
  );
}

/** The abort-shaped error to raise for `signal`: its reason when the reason
 *  is itself abort-shaped, a fresh AbortError wrapping it otherwise. */
export function abortErrorFor(signal: AbortSignal): Error {
  const reason = (signal as { reason?: unknown }).reason;
  if (isAbortError(reason)) return reason as Error;
  return new AbortError('Operation aborted', reason);
}

/** Throw the abort-shaped error for `signal` if it has already aborted. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortErrorFor(signal);
}

export interface LinkedSignal {
  signal: AbortSignal;
  /** Detach every listener this link attached to its input signals. MUST be
   *  called (in a `finally`) once the linked operation settles - the inputs
   *  may be long-lived run signals that outlive the operation by minutes. */
  dispose(): void;
}

/**
 * Combine signals: the returned signal aborts as soon as ANY input does
 * (immediately, if one already has), carrying that input's reason.
 * Undefined inputs are skipped so optional signals compose without ceremony.
 */
export function linkSignals(...signals: Array<AbortSignal | undefined>): LinkedSignal {
  const controller = new AbortController();
  const inputs = signals.filter((s): s is AbortSignal => s !== undefined);
  const attached: Array<{ signal: AbortSignal; onAbort: () => void }> = [];

  const dispose = () => {
    for (const { signal, onAbort } of attached) {
      signal.removeEventListener('abort', onAbort);
    }
    attached.length = 0;
  };

  const forward = (source: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort((source as { reason?: unknown }).reason ?? new AbortError());
    }
    // Once aborted the link is settled - the other inputs no longer matter.
    dispose();
  };

  for (const input of inputs) {
    if (input.aborted) {
      forward(input);
      return { signal: controller.signal, dispose };
    }
  }
  for (const input of inputs) {
    const onAbort = () => forward(input);
    input.addEventListener('abort', onAbort, { once: true });
    attached.push({ signal: input, onAbort });
  }

  return { signal: controller.signal, dispose };
}

/**
 * Sleep that REJECTS (with an abort-shaped error) when `signal` aborts.
 * Listener and timer are cleaned up on every path.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortErrorFor(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortErrorFor(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Await `promise` unless `signal` aborts first, in which case REJECT with an
 * abort-shaped error and stop waiting. The underlying work is NOT cancelled -
 * this is "stop waiting", for operations with no cancellation API (a page
 * navigation already handed to the browser). On abort the orphaned promise
 * gets a no-op catch so its eventual rejection never surfaces as unhandled.
 * The listener is detached on every path.
 */
export function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(abortErrorFor(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      promise.catch(() => {});
      reject(abortErrorFor(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}

/**
 * Non-throwing sleep variant preserving the replay executor's shape: resolves
 * `true` if the signal aborted before the delay elapsed, `false` otherwise.
 * Unlike the bespoke helper it replaces, cleanup leaves no extra timer alive.
 */
export function abortableDelayResult(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (signal?.aborted) {
      resolve(true);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
