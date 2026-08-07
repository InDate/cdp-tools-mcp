---
github: 95
id: 8
type: bug
status: acknowledged
title: "inspect ignores per-step connectionReason in sequences"
startUrl: "about:blank"
recordingName: "manual"
reportedAt: 2026-07-26T02:30:36.000Z
acknowledgedAt: 2026-07-26T02:30:36.000Z
---

## Steps to reproduce
Author a sequence where one step carries its own `connectionReason` targeting a second browser:

```json
{ "tool": "inspect", "params": {
    "action": "evaluateExpression",
    "connectionReason": "device-b",
    "expression": "location.href" } }
```

Run the sequence with a run-level connection of `device-a`.

## Expected
The step evaluates in `device-b`, consistent with how `navigate`/`input`/`content`/`storage` steps behave.

## Actual
The expression evaluates in `device-a`.

`src/tools/replay-executor.ts:1364` injects the run-level connection only for tools in `TOOLS_NEEDING_CONNECTION`, and correctly defers to a per-step override:

```ts
if (connectionReason && TOOLS_NEEDING_CONNECTION.includes(cmd.tool) && !cmd.params.connectionReason) {
  params.connectionReason = connectionReason;
}
```

But that list is `['navigate','content','input','console','network','dom','screenshot','storage']` (`:98-100`) — `inspect` is not in it. `inspect` gets its connection through bespoke branches that hardcode the run-level value instead (e.g. `:1381-1387`).

So per-step connection targeting works for eight tools and silently does the wrong thing for `inspect`. No error is raised; the step just runs against the wrong browser.

## Notes
This is the one that actually blocks multi-device sequences. `inspect({action:'evaluateExpression'})` is how you read app state — in our case a device keypair out of IndexedDB — so it's precisely the step that most needs to name its device.

Worth reviewing the other non-listed tools in the same pass rather than just adding `inspect` to the array; the split between "list-driven" and "bespoke branch" connection resolution looks like the underlying issue.

See also bug-009 (validation machinery has the same blind spot) and feature-013.

<!-- comment: 2026-07-26T03:01:52.140Z -->
Starting work — but flagging up front that the framing in this report looks partly wrong, and I'm writing a failing test before changing anything to establish what is actually broken.

Prior reading of the code suggests the headline repro may already work: `cmd.params` is spread into `params` at :1347 and passed through untouched, and `inspection-tools.ts:218` honours a `connectionReason` in the params it receives. So an `inspect` step that *carries its own* `connectionReason` should already reach the right connection. What is provably broken:

(a) the stale-`callFrameId` refresh branch at :1381-1396 hardcodes the run-level `connectionReason` for its `getCallStack` probe, so it refreshes the frame id from the wrong target;
(b) an `inspect` step with **no** per-step reason gets no injection at all, so it falls back to whatever connection the tool happens to consider active — which can drift.

Fix per the maintainer steer: **not** by adding `inspect` to `TOOLS_NEEDING_CONNECTION`, since that same array drives `sequenceNeedsConnection` and the auto-launch-Chrome logic in replay-tools.ts, and `inspect` is equally a Node-debugging tool (same reason `request` was excluded, see comment at :1368). Instead splitting the list in two: a new "inject the connection into params" list, and the existing array kept as the "needs a browser auto-launched" list. Will report back with what the test actually proved.

<!-- comment: 2026-07-26T03:05:52.066Z -->
Done — and **the headline repro in this report is not a real defect**. Recording what the tests actually proved.

### What the failing test proved
New test file `src/tools/replay-step-connection.test.ts` drives `executeSteps` with a fake `executeToolCall` and records the `connectionReason` of every tool call.

- `passes a per-step connectionReason on an inspect step straight through` — **passed before any fix**. An `inspect` step carrying `connectionReason: 'device-b'` in a run whose run-level connection is `device-a` already reached `device-b`. `cmd.params` is spread into `params` and passed through untouched, and `inspection-tools.ts:218` honours whatever `connectionReason` it is handed. The "Actual: the expression evaluates in device-a" in the report above did not reproduce. If a real run behaved that way, the cause was something else (most likely the connection drift in (b), or a reference that didn't resolve).
- `injects the run-level connection into an inspect step that has none` — **failed** before the fix: `connectionReason` was `undefined`, i.e. the step fell through to whatever connection the tool considered active. Real defect (b).
- `refreshes a stale callFrameId against the step connection` — **failed** before the fix (`device-a` instead of `device-b`). Real defect (a): the refresh branch at :1381 probed `getCallStack` on the run-level connection and then wrote that foreign frame id into a step targeting another target. This is the worse of the two — it doesn't just read the wrong browser, it injects a frame id from the wrong browser.

### What changed
`src/tools/replay-executor.ts`:
- Split the tool list in two, as steered — did **not** add `inspect` to `TOOLS_NEEDING_CONNECTION`:
  - `TOOLS_NEEDING_CONNECTION` (unchanged contents) = "needs a *browser* auto-launched". Still drives `analyzeSequenceConnections`, `sequenceNeedsConnection`, and the auto-launch paths in replay-tools.
  - new `TOOLS_ACCEPTING_CONNECTION` = superset used only for param injection: adds `inspect`, `execution`, `breakpoint`, `getSourceCode`, `detectModals`, `dismissModal`. These are target-agnostic (Chrome *or* Node) so they get pinned to the run's target without dragging a Chrome launch in.
- Injection now checks `!params.connectionReason` (post-interpolation) rather than `!cmd.params.connectionReason`, so an interpolated per-step reason is respected too.
- The stale-`callFrameId` refresh probe now uses the step's own effective connection.

A regression test asserts a Node-only `inspect` sequence still reports `sequenceNeedsConnection === false` and `firstConnectionToolIndex === -1`, i.e. it will not spuriously launch Chrome — the trap that made the naive one-line fix wrong.

`request` stays out of both lists (its `destination: 'node'` form takes no connection at all); its existing special case is unchanged.

Tests: 11 passing in the new file, plus `replay-rebase.test.ts` green. `npx tsc --noEmit` clean for these files.

Not resolving the issue (human-gated) — suggest closing it as *partly not-a-bug*: the per-step override worked; the frame-id refresh and the missing default injection were the real faults, and both are fixed.
