---
github: 109
id: 16
type: bug
status: acknowledged
title: "Sequences have no wait primitive, so any step after async work is a race"
startUrl: "about:blank"
recordingName: "manual"
reportedAt: 2026-07-26T16:05:00.000Z
acknowledgedAt: 2026-07-26T16:05:00.000Z
---

## The gap

There is no way to express "wait until X" as a sequence step. Every available
option is either too short or doesn't wait at all:

- `input({action:'hover'})` has an implicit element wait, but it is short — it
  does not survive a page navigation. Reliable for a re-render, not for a load.
- `inspect({action:'evaluateExpression'})` cannot poll, because it does not
  await promises (bug-015), so `await new Promise(r => setTimeout(r, 500))`
  returns `{}` immediately. A synchronous busy-loop is worse than useless: it
  blocks the event loop, so the thing being waited for can never happen.
- `navigate({waitUntil:'networkidle2'})` waits properly, but only for a
  navigation it performs itself.
- `stepTimeout` bounds a step; it does not retry one.

## Why it bites

Recording a sequence by hand hides this completely. Driving the tool
interactively puts seconds between calls, so async work always looks settled.
The same sequence replayed runs steps back-to-back and reads `PENDING`.

Concrete, from rebuilding the Cue repo's `spine-08-device-revoke-lockout`:

| step | interactive | replayed |
|---|---|---|
| in-page mint → `location.href = url`, then hover the Join button | passes | `Element not found: button:has-text("Join")` |
| kick async IDB/WebCrypto probe, then read the global | returns `READY` | returns `PENDING` |

Both are the same bug. Neither is a product failure.

## What's needed

A first-class wait, e.g.:

```
wait({ selector: '...', timeoutMs })          // element appears
wait({ selectorGone: '...', timeoutMs })      // element disappears
wait({ expression: '...', timeoutMs })        // JS predicate polls true
wait({ ms })                                  // last resort
```

The predicate form is the important one — it covers "a global is no longer
PENDING", which is exactly what the bug-015 workaround needs. Polling has to
happen on the MCP side (re-evaluating a SYNCHRONOUS expression on an interval),
not in-page, precisely because in-page waiting is what's impossible.

Alternatively, a per-step `retryUntil` / `waitFor` option on existing steps
would cover most cases without a new tool.

## Interaction with bug-015

Fixing bug-015 alone does NOT close this. Awaited promises make it possible to
write an in-page poll, which handles "wait for a value". It does not help with
"wait for an element after a navigation", where the page context is replaced
mid-wait. Both are wanted; the wait primitive is the more general of the two.

## Note

This is also the real reason the existing sequences in the wild use the
marker-div + hover-on-`:has-text()` idiom rather than `assert`. It was never
stylistic — hover was the only step that waited at all. It is worth saying so
in the skill once a real wait exists, or the pattern will keep being
cargo-culted.

<!-- comment: 2026-07-26T08:17:53.899Z -->
Starting implementation of the standalone `wait` tool: `wait({selector})`, `wait({selectorGone})`, `wait({expression})` (MCP-side synchronous polling), and `wait({ms})`. Will verify against a real browser with a navigate-then-wait sequence replay.

<!-- comment: 2026-07-26T08:29:30.883Z -->
Implemented the `wait` tool as specced.

**What was built**
- New tool `wait` (src/tools/wait-tools.ts), exactly one of: `selector` (appears), `selectorGone` (disappears), `expression` (synchronous predicate), `ms` (sleep, last resort). Defaults: `timeoutMs` 15000, `pollIntervalMs` 100.
- All condition forms poll from the MCP side via `Runtime.evaluate` (`awaitPromise: false`, exact by-value capture). I did NOT use puppeteer's `waitForSelector` even for the element forms: extended `:has-text()` selectors aren't native CSS, and one server-side polling code path handles navigation mid-wait uniformly (each poll simply runs in whatever document exists; context-destroyed errors are swallowed and polling continues). Extended selectors are compiled to a self-contained inline text-match predicate (`buildPresencePredicate`), not the data-attribute marking `resolveSelector` uses - marks would not survive a navigation.
- Fail-fast paths: paused debugger (`WAIT_DEBUGGER_PAUSED` - the event loop is stopped so the condition can never flip; burning the timeout would be pure waste), invalid CSS selector syntax, zero/multiple forms, missing connectionReason. Timeout (`WAIT_TIMEOUT`) includes the last evaluation error so a predicate that throws forever (`myGlobal is not defined`) is diagnosable.
- Executor integration: `wait` added to `TOOLS_ACCEPTING_CONNECTION` (run-level connection injected, per-step `connectionReason` honoured per bug-009). New param-aware `commandNeedsBrowserConnection()` replaces raw `TOOLS_NEEDING_CONNECTION.includes()` at the four decision sites: `wait({ms})` and `wait({expression})` never trigger a Chrome auto-launch (`expression` is target-agnostic like `inspect` - it works against Node too); selector forms do.
- New message templates: WAIT_CONDITION_MET, WAIT_SLEEP_COMPLETE, WAIT_TIMEOUT, WAIT_INVALID_ARGS, WAIT_DEBUGGER_PAUSED. `wait` added to TOGGLEABLE_TOOLS. `_meta.wait` structured metadata (form, condition, satisfied, elapsedMs, polls).
- Docs: tool-categories.md, instructions.md, replay.md (new "Explicit Waits" section), and sequences.md now has a "Waiting for async work" section that explicitly calls out the marker-div + hover-on-`:has-text()` idiom as a workaround for the missing wait, not style.

**Real-browser verification (headless Chrome, replayed sequences)**
- Baseline (no wait): navigate to a page that redirects via `location.href` after 700ms, then querySelector the Join button - failed at 0.1s with `Element not found: #join`. The exact race from this issue.
- Fixed: same flow with `wait({selector: 'button:has-text("Join")'})` (button rendered async 900ms after the redirect target loads), `wait({selectorGone: '.spinner'})`, and `wait({expression: "window.__probe !== 'PENDING'"})` (global flips at 1.4s) + assert on the captured value - 8/8 steps in 2.5s.
- Timeout: `wait({selector: '#never-exists', timeoutMs: 1500})` failed cleanly at exactly 1.5s ("Timed out after 1500ms (15 checks) waiting for element \"#never-exists\" to appear") and stopped the run. No hang.

**Gates**: tsc clean, 451 tests passing (16 new in wait-tools.test.ts), build ok, verify-mcp exit 0 (36 tools, both catalogs in sync).

**Notes / residual**
- `stepTimeout` is computed in the executor (`effectiveStepTimeout`) but never actually enforced per step - pre-existing; a long `wait` is bounded by its own `timeoutMs` and the run's `totalTimeout`, so this doesn't bite here, but worth its own issue.
- A per-step `retryUntil` (the issue's alternative) was not implemented - the standalone tool covers the cases and per-step retry semantics interact badly with steps that have side effects.
