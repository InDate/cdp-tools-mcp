---
github: 96
id: 9
type: bug
status: acknowledged
title: "Sequence click validation ignores per-step connectionReason"
startUrl: "about:blank"
recordingName: "manual"
reportedAt: 2026-07-26T02:30:36.000Z
acknowledgedAt: 2026-07-26T02:30:36.000Z
---

## Steps to reproduce
In a sequence running against connection `device-a`, add an `input({action:'click', connectionReason:'device-b'})` step.

## Expected
The click executes in `device-b` and its validation — DOM-change detection, console-error checking, navigation checking — also observes `device-b`.

## Actual
The click executes in `device-b` (correctly — `input` is in `TOOLS_NEEDING_CONNECTION`), but every piece of machinery wrapped around it stays pointed at the run-level connection:

- click validation — `src/tools/replay-executor.ts:1481`, `:1545`
- typed-text validation — `:1627`
- `waitForElement` prefetch — `:1635`
- `resumeIfPaused` / `checkIfPaused` — `:1262`, `:1604`
- post-run debug state and `killChromeOnFinish` — `src/tools/replay-tools.ts:794-797`, `:802`

So a cross-connection step runs, but is validated against the wrong browser. With `clickValidation.failOnConsoleErrors: true` that means console errors in the target device are missed, while unrelated state in the run-level device can fail the step.

## Notes
Same root cause as bug-008: per-step connection support was added at the dispatch point (`:1364`) without threading through the surrounding validation/pause code, which all reads the single `connectionReason` off `ExecutionContext` (`replay-tools.ts:607`).

Probably wants the resolved per-step connection computed once and passed down, rather than each site reaching for the context value.

Not blocking — the workaround is to split per-device work into separate sequences — but it makes single-file multi-device sequences untrustworthy rather than merely awkward.

<!-- comment: 2026-07-26T03:01:45.446Z -->
Starting work on this.

Plan: in `executeSteps` (src/tools/replay-executor.ts) compute the **effective connection for each step** once (per-step `params.connectionReason` if present, else the run-level one) and pass a shallow `ctx` clone carrying it into every helper that currently reads the run-level value off `ExecutionContext` — `capturePreClickState`, `validateClickAction`, `validateNavigation`, `validateTypedText`, `waitForElement`, `checkIfPaused`, `gatherDiagnostics` — and make the loop guards at :1481/:1545/:1604/:1627/:1635 test the per-step value instead. The helpers themselves keep reading `ctx.connectionReason`; only the ctx they receive changes, so there is no signature churn.

One deliberate refinement: the `waitForElement` prefetch at :1635 waits for the **next** step's element, so it will use the *next* step's effective connection, not the current step's.

Also fixing bug-008 in the same pass (shared root cause). Writing failing tests first.

<!-- comment: 2026-07-26T03:06:09.001Z -->
Fixed. Every site listed in the report was confirmed broken by a test first, then fixed.

### Shape of the fix (`src/tools/replay-executor.ts`, `executeSteps`)
Once per step, after interpolation and connection injection:

```ts
const stepConnection = params.connectionReason || connectionReason;
const stepCtx = stepConnection === connectionReason
  ? ctx
  : { ...ctx, connectionReason: stepConnection, variableStore: (ctx.variableStore ??= {}) };
```

Helpers were left untouched — they still read `ctx.connectionReason`; they simply receive a ctx whose connection is the step's. The variable store is shared by reference into the clone so `request({ saveAs })` capture and `{{var:...}}` interpolation still see one store.

Sites now using `stepCtx` / `stepConnection` instead of the run-level value:
- `capturePreClickState` + guard (was :1481)
- `validateClickAction` + guard (was :1545)
- `validateNavigation` post-navigate + guard (was :1535)
- `validateTypedText` + guard (was :1627)
- `checkIfPaused` post-step breakpoint probe + guard (was :1604)
- `gatherDiagnostics` on step failure
- the stale-`callFrameId` refresh probe (bug-008 (a))
- `executeConditionalFlow` (a conditional step naming a connection now runs its branch there)

The pre-run `resumeIfPaused` at :1262 deliberately stays run-level — it is run setup, before any step exists.

`waitForElement` prefetch got a **deliberate refinement**: it waits for the *next* step's element, so it now resolves the **next** step's connection, not the current step's. Test `prefetches the next element on the NEXT step connection` pins this.

### handleRun tail (`src/tools/replay-tools.ts:798-828`)
- `killChromeOnFinish` now tears down **every browser connection the sequence named**, not just the run-level one — otherwise a per-step device leaks a live Chrome on every run. Only steps whose tool is in `TOOLS_NEEDING_CONNECTION` contribute (a per-step reason on a Node-debugging step is not a Chrome to kill), references are deduped, and ports are deduped so two tabs of one browser aren't killed twice. The message now names the reference alongside the port.
- Judgement call: the post-run `getDebugState` at :794 is **left run-level on purpose**. There is no single "the step's" connection once the run is over, and a debug summary of the run-level target is the meaningful thing to print. Happy to change it to a per-connection summary if you'd rather.

### Tests
New `src/tools/replay-step-connection.test.ts` (11 tests): 10 of them failed before the fix, all pass now. Covers pre-click capture + click validation, navigate validation, typed-text validation, pause probing, next-step prefetch, failure diagnostics, and a mixed sequence asserting run-level steps stay on `device-a` while the overriding step and its machinery go to `device-b`.

`npx vitest run src/tools/replay-rebase.test.ts src/tools/replay-step-connection.test.ts` → 18 passed. `npx tsc --noEmit` clean for these files.

Not resolving (human-gated) — ready for verification.

<!-- comment: 2026-07-26T03:53:28.416Z -->
**Review finding 4 (killChromeOnFinish killed browsers the run does not own) — fixed.**

What the review found: the kill block in `handleRun` (src/tools/replay-tools.ts) had been widened to tear down EVERY browser connection named by any step, not just the run-level one. For multi-device sequences that means one `replay({run, killChromeOnFinish:true})` kills a long-lived instance the user launched by hand and expects to keep. Two further defects in the same block: it read PRE-interpolation `cmd.params.connectionReason` (so a `{{var:...}}` reference was silently skipped) and it never scanned steps nested inside `conditional` sequences — i.e. simultaneously over- and under-inclusive.

**Chosen option: reverted to run-level-only.** Nothing in the run currently tracks which connections it caused to be launched: `didAutoLaunch` covers the run-level connection only, `StepResult` carries no payload, and a `launchChrome` step is not proof of ownership because `launchChrome` reuses an existing connection with the same reference (`CHROME_CONNECTION_REUSED`, src/index.ts:415-446). Making that trackable means changing `replay-executor.ts`, which is outside this change's scope. Per the "don't guess" rule we under-kill: a leaked browser is visible and closable, a killed one takes state the user cannot get back. The interpolation and nested-conditional defects disappear with the step scan.

Also updated the `killChromeOnFinish` schema description to state that browsers reached via a step's own `connectionReason` are left running.

Tests: new `src/tools/replay-kill-chrome-on-finish.test.ts` (4 tests) drives `replay({action:'run', killChromeOnFinish:true})` end-to-end with a mocked tool bus and asserts the run-level port is killed exactly once, a borrowed per-step connection survives (including when its reference is an uninterpolated `{{var:...}}` — `getConnectionPort` is never even asked about it), and nothing is killed without the flag. `npx tsc --noEmit` clean for these files; replay-rebase / replay-step-connection / replay-capture-variables / replay-tool-name-validation all green.
