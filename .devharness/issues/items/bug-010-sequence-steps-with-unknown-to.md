---
github: 97
id: 10
type: bug
status: acknowledged
title: "Sequence steps with unknown tool names fail only at run time"
startUrl: "about:blank"
recordingName: "manual"
reportedAt: 2026-07-26T02:30:36.000Z
acknowledgedAt: 2026-07-26T02:30:36.000Z
---

## Steps to reproduce
Hand-author a sequence JSON with a typo'd tool name (`{"tool": "inpsect", ...}`), then `replay({action:'load'})` and `replay({action:'run'})`.

## Expected
`load` (or `create`) rejects the unknown tool name.

## Actual
Nothing validates tool names at create or load time. `RecordedCommand.params` is `Record<string, any>` (`src/command-recorder.ts:16-21`) and the name is only resolved at dispatch, in `executeToolCall` (`src/index.ts:1157-1178`), which throws on an unknown name. So the sequence loads clean and dies mid-run — after earlier steps have already mutated browser state.

## Notes
Low severity, but the cost lands on hand-authored sequences specifically, which is exactly what multi-device tests require (they can't be recorded — see feature-013).

Validating names against the `allTools` map at load would be cheap. Validating each step's params against its tool's zod schema would be better and would also catch the `about:blank` class of problem early.

<!-- comment: 2026-07-26T03:14:41.440Z -->
Starting work on this. Plan: validate step tool NAMES strictly at `replay` create/load time (hard error listing offending step index + name), in `handleCreate`/`handleLoad` in `src/tools/replay-tools.ts`.

Deliberately NOT validating step params against each tool's zod schema, contrary to the "would be better" note in this issue: params legitimately hold interpolation tokens (`{{var:...}}`, `{{timestamp}}`) that are only substituted at run time in `replay-executor.ts`, so e.g. a number-typed field can validly hold a string token. Typed validation would false-fail on valid hand-authored sequences.

Wiring: `createReplayTools` will take an OPTIONAL lazy tool-name provider (`() => string[]`), because the `allTools` map in `src/index.ts` is defined after tool creation. Optional so today's behaviour is preserved when absent (another agent currently owns `src/index.ts`; the one-line call-site change will be handed to the parent).

<!-- comment: 2026-07-26T03:18:02.921Z -->
Done (working tree, uncommitted).

**Changed** — `src/tools/replay-tools.ts` only:
- New exported `findUnknownStepTools(commands, knownToolNames)` + `validateSequenceToolNames()` / `unknownStepToolsError()` helpers. Errors list every offending step as `Step N: \`name\` is not a known tool`, with a Levenshtein-based "did you mean" suggestion (`inpsect` -> `inspect`) and the sorted list of known tools.
- `handleCreate` and `handleLoad` validate before doing anything else; on failure the sequence is removed from the in-memory map (`deleteSequence`) so it can't still be run by id, and for `load({intoHistory:true})` nothing is pushed into history.
- `createReplayTools` gained an optional 5th param `getKnownToolNames?: () => string[]` (lazy — `allTools` in `src/index.ts` is built after the factory runs). Absent => no validation, i.e. today's behaviour.

**Tests** — new `src/tools/replay-tool-name-validation.test.ts`, 14 cases (provider supplied and absent, empty provider list, intoHistory, create path, params-with-tokens are ignored). All pass; `replay-rebase` / `replay-step-connection` / `replay-capture-variables` still pass (52 total). `npx tsc --noEmit` clean.

**Findings that qualify/contradict the issue:**
1. `conditional` is a *virtual* step tool — handled inside `executeSteps` (`replay-executor.ts:1532`) and never dispatched through `allTools`. Naive validation against the `allTools` map, as the issue suggests, would falsely reject every sequence using conditionals. It's whitelisted via `VIRTUAL_STEP_TOOLS`.
2. Params are deliberately NOT validated against zod schemas (see earlier comment): `{{var:...}}` / `{{timestamp}}` tokens are substituted at run time, so typed validation would false-fail. The issue's "would be better" note is wrong on this point as things stand.
3. `allTools` is config-dependent (disabled tool groups drop out), so a sequence referencing a disabled tool now errors at load. That matches run-time behaviour (`executeToolCall` would throw anyway), just earlier.
4. `replay({action:'run'})` loads via `loadSequence` in `replay-executor.ts`, which is outside this change's scope (another agent owns that file), so `run` on a *never-loaded* sequence file still fails at dispatch. Worth a follow-up: hoist the same check into `loadSequence`.
5. No message template was added (docs/messages.md is owned elsewhere) — the error is a plain isError response. A `SEQUENCE_UNKNOWN_TOOL` template would be the tidier home. Note `INVALID_INDICES` is already referenced from replay-tools.ts twice with no template in docs/messages.md, so it currently renders "Message not found" — pre-existing, separate bug.

Wiring left to the parent (one line, `src/index.ts:1321`): `  }) : {}),` -> `  }, () => Object.keys(allTools)) : {}),`.

<!-- comment: 2026-07-26T03:53:35.538Z -->
**Review finding 7 (a rejected create destroyed the existing sequence) — fixed.**

What the review found: `CommandRecorder.createSequence` called `removeSequenceByName(name)` (dedupe for #75) BEFORE `handleCreate` ran `validateSequenceToolNames`. Creating an invalid sequence under an existing name therefore deleted the good in-memory copy and then rejected the bad one, leaving the user with neither. In-memory only, so low severity, but the ordering was plainly wrong.

Fix: `createSequence` now takes an optional `options.validate(candidate)` callback that runs on the fully built candidate BEFORE the same-name removal; returning false makes it return `null` having touched nothing. `handleCreate` (src/tools/replay-tools.ts) passes the bug-010 tool-name check through that hook and returns the validation error, so the reject path is now entirely non-destructive — and the post-create `deleteSequence` compensation is gone.

Tests (src/tools/replay-tool-name-validation.test.ts): three new cases against a REAL `CommandRecorder` — after a rejected same-named create the original sequence still exists under its original id with its original commands, still resolves via `replay({action:'get', name})`, and a valid same-named create still replaces the old one (#75 dedupe intact). Existing mock recorder updated to mirror the real validate-then-store ordering.

Note for follow-up (not fixed here, same class of bug): `loadSequenceFromDisk` also calls `removeSequenceByName` before `handleLoad` validates, so a bad file on disk still evicts a good same-named in-memory sequence before being rejected. Fixing it needs a parse/register split in the recorder.
