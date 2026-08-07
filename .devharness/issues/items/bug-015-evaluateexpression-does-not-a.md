---
github: 108
id: 15
type: bug
status: acknowledged
title: "evaluateExpression does not await promises, so saveAs cannot capture anything async"
startUrl: "about:blank"
recordingName: "manual"
reportedAt: 2026-07-26T15:40:00.000Z
acknowledgedAt: 2026-07-26T15:40:00.000Z
---

## Steps to reproduce

```
inspect({ action: 'evaluateExpression', expression: "(async () => 'AWAITED_OK')()" })
```

## Expected
`"AWAITED_OK"`.

## Actual
`{}` — the Promise itself, rendered as an empty object. Synchronous
expressions in the same connection return correctly (`'LANDED'`, etc.), so it
is specifically promise resolution that is missing: `Runtime.evaluate` is
presumably called without `awaitPromise: true`, and there is no parameter on
the tool to opt in (the schema has no `awaitPromise`).

## Why this matters more than it first looks

**It largely defeats feature-014.** `saveAs` on `evaluateExpression` was added
so a sequence could capture a value mid-run. But essentially everything worth
capturing from a page is async:

- IndexedDB reads (`indexedDB.open` → transaction → request)
- WebCrypto (`crypto.subtle.digest` / `.sign`)
- `fetch`

All of those can only be expressed as an async IIFE, and all of them now
capture `{}`. In practice `saveAs` works for synchronous DOM reads and little
else.

**It also explains the marker-hover hack.** Sequences in the wild do this:

```
inspect  → async IIFE that fetches, then document.body.insertAdjacentHTML(
             'beforeend', '<div data-probe>AUTH_OK</div>')
input    → hover on :has-text("AUTH_OK")     // fails the step if absent
```

That reads like legacy style predating `assert`, but it isn't — it is a
workaround for this bug. The async work is driven for its **side effects**,
because its return value is unreachable. Fixing this is what actually retires
the hack; adding `assert` alone did not.

## Fix

Pass `awaitPromise: true` to `Runtime.evaluate` (and to
`Runtime.callFunctionOn` on the call-frame path, if that is used for
`callFrameId` evaluation). Worth guarding with the existing timeout so a
never-settling promise fails the step instead of hanging — see bug-004, which
was the same class of problem (a throw that never returned).

If awaiting unconditionally is too blunt, add an `awaitPromise` boolean to the
tool schema — but the default should be to await, since returning a bare `{}`
gives the caller no signal that anything was dropped.

## Notes

Found while recording a replacement for the Cue repo's
`spine-08-device-revoke-lockout` sequence, which needs to read a
non-extractable device key out of IndexedDB and sign a request with it — all
async, all currently uncapturable. Workaround in the meantime is the
side-effect pattern: fire the async work, have it stash its result on a global,
then read that global in a separate SYNCHRONOUS `evaluateExpression` (which can
carry `saveAs`).

<!-- comment: 2026-07-26T07:35:31.398Z -->
Starting work on this (agent). Plan: (1) empirically probe CDP semantics first — does `awaitPromise` on `Debugger.evaluateOnCallFrame` hang while paused (event loop stopped), can `[[PromiseState]]`/`[[PromiseResult]]` internal properties recover an already-settled promise at a paused frame, and how `returnByValue`/`Runtime.callFunctionOn` serialization fails on non-serializable values. (2) Implement: `awaitPromise: true` default on the `Runtime.evaluate` path; paused path handled without a blind await; exact raw-value capture for `saveAs`/`_meta` that avoids re-executing the expression. (3) Verify against a real browser through the live MCP server plus unit tests. Findings to follow.

<!-- comment: 2026-07-26T07:47:33.753Z -->
Fixed (pending human verification). Summary of findings and implementation:

**Empirical CDP findings (Chrome 150, probed before implementing):**
- `Runtime.evaluate` + `awaitPromise: true` resolves promises normally while the page runs; a rejection surfaces as `exceptionDetails` ("Uncaught (in promise) ...").
- `Debugger.evaluateOnCallFrame` **ignores** `awaitPromise` entirely — it returns the Promise RemoteObject immediately. It does not hang, but it also never awaits.
- The real hang trap is elsewhere: `Runtime.evaluate` + `awaitPromise` **while the debugger is paused** (global eval, no callFrameId) hangs indefinitely — the paused event loop can never settle the promise.
- While paused, `[[PromiseState]]`/`[[PromiseResult]]` internal properties are readable, so **already-settled** promises can still be resolved exactly (e.g. `Promise.resolve(x)`, results of async work started before the pause).

**Implementation** (`src/cdp-manager.ts`, `src/tools/inspection-tools.ts`):
- `awaitPromise: true` by default on `Runtime.evaluate` when the page is running. New `awaitPromise: false` schema param opts back into inspecting the Promise object itself.
- Paused contexts (callFrameId given, or global eval while paused): `awaitPromise` is never passed to CDP. A Promise result is resolved via its internal properties — fulfilled → exact value; rejected → `EvaluateExpressionExceptionError`; pending → new fast-fail `EvaluateExpressionPendingPromiseError` / `EVALUATE_PROMISE_PENDING_WHILE_PAUSED` with resume/opt-out guidance (no 10s timeout burn).
- `saveAs` / `_meta.inspect.value` now capture **by value** via `Runtime.callFunctionOn(returnByValue)` on the result object — exact, no re-execution of the expression, no display-text round-trip. Non-JSON-serializable values (DOM nodes, Date, Map, window) fall back to the previous display-derived reconstruction; `_meta.inspect.valueSource` reports `'exact' | 'display'`. Rejections with primitive reasons (`Promise.reject('str')`) now surface the reason instead of "Unknown error".

**Real-browser verification (live MCP server, headless Chrome):** the issue's async IIFE returns `"AWAITED_OK"`; rejection surfaces as the expression's own error with stack; a sequence step captured a real IndexedDB read + `crypto.subtle.digest('SHA-256','bug-015')` and asserts passed on the exact hex, on a string `'42'` staying a string, and on a value nested below display `maxDepth` (reachable only via exact capture); at a `debugger` pause, a pre-pause settled promise evaluated to its value on both the call-frame and global paths, a pre-pause rejected one raised the exception, and a pending `fetch` failed instantly with the explanatory error.

Docs updated (`tool-categories.md`, `instructions.md`, `replay.md`, `messages.md`). 14 new unit tests (10 fail against pre-fix code); full suite 435 passing; `tsc`, build and `verify-mcp` clean. The marker-hover / stash-on-global workarounds in existing sequences can now be retired.
