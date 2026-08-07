---
github: 101
id: 14
type: feature
status: acknowledged
title: "Capture sequence variables from more than request saveAs"
startUrl: "about:blank"
recordingName: "manual"
reportedAt: 2026-07-26T02:30:36.000Z
acknowledgedAt: 2026-07-26T02:30:36.000Z
---

## Problem
The `{{var:name.path}}` store has exactly one write path: `request({saveAs})` (`src/tools/replay-executor.ts:1597-1600`). No other tool can capture a value. In particular `inspect({action:'evaluateExpression'})` — the tool you'd use to pull state out of the page — cannot.

Consequence: any value that isn't an HTTP response body has to be smuggled. The workaround in practice is to have an `evaluateExpression` step write a marker string into the DOM, then `input({action:'hover'})` on `:has-text("MARKER")` so the step fails if it's absent. That's an assertion built out of a hover.

Two further limits on the store's reach:

- It is created fresh per run (`src/tools/replay-tools.ts:609`) and never serialized — `saveSequenceToDisk` writes only `{_comment, id, name, description, expectedOutcome, startUrl, commands, createdAt}` (`src/command-recorder.ts:401-406`). There is no export/import.
- The `variables` param on `replay` (`replay-tools.ts:112`) is *not* related — it substitutes typed text by positional key `var_${i}_${selector}` (`replay-executor.ts:1355-1361`) and never touches the `{{var:}}` store. The name collision is itself a trap.

## Proposed
1. `saveAs` on `inspect`, `dom`, and `content` — capturing an evaluated value, an attribute/text, or extracted content into the same store.
2. An explicit export/import so a value can cross a run boundary, e.g. `replay({action:'run', exportVariables:['pairingUrl']})` and a matching `variables` input on the next run — under a name that doesn't collide with the existing typed-text `variables`.

## Notes
Nested sequences already share the store: `executeConditionalFlow` (`replay-executor.ts:269`, `:317-341`) passes `{...ctx}` to the child, so `variableStore` is shared **by reference** and variables cross the boundary in both directions today. So (2) may be partly solvable by documenting `conditional` as the composition mechanism rather than adding a new one.

One sharp edge if you go that route: the sharing relies on the parent's store already being a non-null object. `(ctx.variableStore ??= {})` at `:1599` would create a *child-local* object if the parent's were undefined, silently breaking the sharing. The `run` path always seeds `{}` at `replay-tools.ts:609`, so only hand-built `ExecutionContext`s hit it — worth hardening regardless.

Also worth documenting: `assert` (`src/tools/assert-tools.ts:91-141`) works fine as a sequence step — there is no allowed-tool list; `executeToolCall` dispatches against the full tool map (`src/index.ts:1157-1178`) and a failed assert throws and breaks the run loop (`replay-executor.ts:1641-1651`). Existing sequences in the wild use the hover-on-marker hack instead, which suggests `assert` predates or is simply undiscovered. Combined with (1), `assert` over a captured `inspect` value would replace that hack entirely.

<!-- comment: 2026-07-26T03:09:29.132Z -->
Starting implementation (scoped round 1).

Plan:
- Prerequisite: `inspect` returns no `_meta` at all today, so there is nothing for the executor to capture. Adding a structured `_meta.inspect` to `evaluateExpression`, modelled on `request-tools.ts:166` (`_meta.request`). Note `cdpManager.evaluateExpression()` returns display-formatted values (`formatValue` quotes strings and stringifies numbers), so the meta will carry a best-effort de-formatted `value` alongside the expression.
- `saveAs` on `inspect` (same param name as `request` - one concept, one name). Scoped to `evaluateExpression` this round; `dom`/`content` deliberately left for a later round.
- Executor: replace the hardcoded `cmd.tool === 'request'` capture at `replay-executor.ts:1637` with a small per-tool capture-source table, so adding `dom`/`content` later is a one-line change. For `inspect` the store gets the *value itself* (so `{{var:pairingUrl}}` is the string), where `request` keeps storing the whole response meta (`{{var:r.body}}`) - unchanged.
- Harden the sharp edge you flagged: `(ctx.variableStore ??= {})` inline at the capture site is replaced by seeding the store once at the top of `executeSteps` and using that single object everywhere (capture, interpolation, per-step ctx clone, prefetch clone), so parent/child/clone always share one object by reference.
- Part 2 (cross-run export/import) is out of scope this round.

Will not touch `handleCreate`/`handleLoad`, docs/messages.md, or the other agents' files.

<!-- comment: 2026-07-26T03:13:43.628Z -->
Round 1 implemented (inspect only). Not committed - left in the working tree for review.

**What changed**

`src/tool-response.ts`
- New `InspectToolMeta { expression, value, valueType, callFrameId? }` + `inspect?` on `ToolResponseMeta`. (Not in my nominal scope, but the executor needs a type to read; it was the minimum necessary.)

`src/tools/inspection-tools.ts`
- `evaluateExpression` now returns `_meta: { tool:'inspect', action:'evaluateExpression', timestamp, inspect: {...} }`. Text output is byte-identical - no new message templates needed.
- New exported `deformatEvaluatedValue()`. **This is the part the issue does not mention and is the real work:** `CDPManager.evaluateExpression()` does not return a value, it returns *display text*. `formatValue()` (cdp-manager.ts:1581) renders a string as `"quoted"`, a number/boolean as its `String()` form, undefined/null as the words, and objects/arrays as containers whose leaves are those strings. So there was no raw value to publish. `deformatEvaluatedValue` reverses that shaping (the quoting is the type signal: `"42"` -> string `42`, `42` -> number `42`) and recurses through objects/arrays. It is explicitly best-effort: anything `formatValue` collapsed to a description (a DOM node -> `[HTMLDivElement]`, a depth-limited object -> its class name) is unrecoverable and stays a string. A lossless fix would need a `returnByValue` path in `cdp-manager.ts`, which is outside this task's file scope - worth a follow-up if captured objects turn out to matter more than captured strings/numbers.
- `saveAs` added to the (strict) inspect schema.

`src/tools/replay-executor.ts`
- Replaced the hardcoded `cmd.tool === 'request'` capture with a `CAPTURE_SOURCES` table + exported `captureVariable(tool, params, result)`. `request` still stores the whole response object (`{{var:login.body.token}}`); `inspect` stores **the value itself**, so a captured string is `{{var:pairingUrl}}` and an object is `{{var:state.user.id}}`. Adding `dom`/`content` later is one table entry plus that tool's `_meta`.
- Capture moved to *before* the step is marked successful, and a `saveAs` that cannot be honoured is now a step failure that stops the run (`saveAs is not supported on "dom" steps...`, or `"inspect" (action: getCallStack) returned no capturable result - only inspect({action:"evaluateExpression"}) can be captured`). Previously a `saveAs` that produced nothing was a silent no-op that surfaced much later as a confusing "no variable named X" interpolation error.
- Hardening: `(ctx.variableStore ??= {})` no longer appears at any capture/clone site. The store is seeded once at the top of `executeSteps` on the caller's own ctx, and that single object is used for interpolation, the per-step `stepCtx` clone, the prefetch clone, and captures - so parent/child/clone always share one object by reference and a hand-built `ExecutionContext` can no longer fork it.

**Tests** - new `src/tools/replay-capture-variables.test.ts`, 20 tests: `deformatEvaluatedValue` shaping/recursion/unrecoverable cases, the inspect `_meta` shape (incl. `callFrameId`, and that error responses carry no capturable meta), `saveAs` accepted by the strict schema, the `captureVariable` table incl. both rejection paths, and end-to-end executor runs (capture -> interpolate; type preservation through `{{var:state.user.id}}`; request unchanged; failure stops the run; store seeded on a bare ctx; a capture made on a per-step-connection clone landing in the run-level store).

`npx vitest run src/tools/replay-capture-variables.test.ts src/tools/replay-rebase.test.ts src/tools/replay-step-connection.test.ts` -> 38 passed. `npx tsc --noEmit` clean apart from pre-existing `storage-tools.test.ts` errors owned by another agent.

**Contradicting / worth noting for the issue as written**
- The issue frames (1) as "just add saveAs to inspect/dom/content". For `inspect` that was the smaller half - the tool emitted no `_meta` at all, and the value it *does* produce is display-formatted, so a value had to be reconstructed. `dom`/`content` will hit the same prerequisite: they need structured `_meta` before `saveAs` means anything.
- Part 2 (cross-run export/import) is **not** free from this design - the store is still per-run and unserialized. The note in the issue is right that nested `conditional` sequences already share it by reference (and my hardening makes that reliable rather than accidental), so documenting `conditional` as the composition mechanism remains the cheapest path.
- `src/tools/interpolation.ts:74` still hardcodes the hint "use a prior request({ saveAs: ... }) step" and `assert-tools.ts:94`'s description says the same. Both are now incomplete (inspect can also capture). Out of my file scope; left alone deliberately. Same for the `saveAs` lines in `docs/instructions.md:174-175` and `skills/cdp-tools/references/tool-categories.md:48-49`.
