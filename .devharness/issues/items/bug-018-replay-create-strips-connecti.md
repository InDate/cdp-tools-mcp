---
id: 18
type: bug
status: acknowledged
title: "replay create strips connectionReason, so a recorded multi-browser sequence silently collapses to one browser"
startUrl: "about:blank"
recordingName: "manual"
reportedAt: 2026-07-26T13:00:00.000Z
acknowledgedAt: 2026-07-26T13:00:00.000Z
---

## Steps to reproduce

Drive two connections, then build a sequence from that history:

```
launchChrome({ reference: 'duo owner console',  forceNewInstance: true })
launchChrome({ reference: 'duo member device',  forceNewInstance: true })

input({ action:'click', selector:'…', connectionReason:'duo-owner-console' })   # index 140
input({ action:'click', selector:'…', connectionReason:'duo-member-two'  })     # index 127
…
replay({ action:'create', name:'duo-…', indices:[140, 126, 127, 128, 129, 130, …] })
```

## Expected

The stored commands keep the `connectionReason` each call was made with, so a replay reproduces the same two-browser interleaving.

## Actual

Every stored command has it stripped. `replay({action:'get', outputFormat:'commands'})` returns:

```json
{ "tool": "input", "params": { "action": "click", "selector": "button:has-text(\"Stock\")" } }
```

— no `connectionReason`, on any step, whether it was driven against the owner or the member connection.

On replay, `replay-executor` injects the run-level connection into every step that lacks one, so all nine steps execute in a single browser.

## Why this is the worst kind of failure

**It does not error — it passes.** My sequence was: owner opens Stock and records the value → member draws a unit → owner waits for the value to change → assert it decremented by exactly one. Replayed single-browser, the "member" steps run in the owner's browser, so the owner draws from their own sheet, sees their own optimistic update, and the assertion goes green. The sequence reports that cross-user live propagation works while never having involved a second user.

A sequence whose entire purpose is proving something crosses a boundary quietly stops testing the boundary, and there is no signal in the output.

## Context

This is the direct blocker for the workflow the recent per-step `connectionReason` work exists to enable. The executor side is done — `replay-executor.ts:1364` honours a per-step `connectionReason` and bug-008/bug-009 extended that to `inspect` and to the validation/pause machinery. But the only supported way to *build* a sequence is `create` from history (or `recordInteraction`, which is single-connection by construction), and `create` throws the connection away. So multi-browser sequences cannot currently be authored through any supported path — hand-editing the JSON is the only option, and that is explicitly discouraged.

## Fix

Preserve `connectionReason` in the recorded command when the call carried one. The executor already does the right thing with it (`!cmd.params.connectionReason` guard), so nothing downstream changes.

Two details worth deciding:

- **Run-level vs per-step.** If every step in a sequence shares one connection, keeping it per-step makes the sequence non-portable — `replay({action:'run', connectionReason:'other'})` would be ignored. Best behaviour is probably: record it, but on `create`, if ALL steps share the same value, hoist it off the steps and leave them bare so the run-level override still works. Only keep it per-step where the sequence genuinely spans connections.
- **Reference naming.** Connection references are per-session (`duo-member-two` won't exist in another session). A portable multi-browser sequence needs its references declared and mapped at run time — e.g. `replay({action:'run', connections:{ 'duo-member-two':'my-second-browser' }})`. Without that, a recorded two-browser sequence only replays in the session that recorded it.

The second point may be the more important one: preserving the reason is necessary but not sufficient for a sequence that anyone else can run.

## Related

- bug-017 — `findInteractive` returning another connection's cached page. Same root theme: the multi-browser path works at the executor level but the surrounding tooling still assumes one browser.

<!-- comment: 2026-07-28T03:45:45.569Z -->
## Verified end-to-end (2026-07-28)

Fix is in the working tree (uncommitted): `command-recorder.ts` keeps the recorded `connectionReason`; `create` hoists it back off when uniform; `replay-executor` rebinds per-step references via a new `connections` arg and fails the step when the reference is absent.

Live check with two headless Chromes (`duo-owner-console` → owner.html, `duo-member-device` → member.html, click in member only):

1. `create` from history — all 5 steps kept their `connectionReason`, and the output flagged it as a multi-connection sequence with the rebinding instructions.
2. `run` with a run-level `connectionReason: 'duo-owner-console'` — 5/5 passed and the browsers ended in *different* states (owner `OWNER/owner`, member `MEMBER/member-clicked`). Pre-fix the owner would have ended on member.html. The run-level connection no longer collapses the sequence.
3. `run` with `connections: { 'duo-member-device': 'spare replay target' }` — the third browser ended at `MEMBER/member-clicked`, i.e. the recorded reference was rebound onto this session.
4. `run` with the member mapped to a reference that doesn't exist — failed loudly at step 2 with the "NOT run against the run-level connection" error instead of silently falling back.
5. A `connections` key naming no recorded reference is rejected up front (typo guard).

Unit coverage: `src/tools/replay-multi-connection.test.ts` (22 tests). Full suite 542 passed, `tsc --noEmit` clean.
