---
github: 99
id: 12
type: feature
status: acknowledged
title: "storage: sessionStorage get/set and single-key delete"
startUrl: "about:blank"
recordingName: "manual"
reportedAt: 2026-07-26T02:30:36.000Z
acknowledgedAt: 2026-07-26T02:30:36.000Z
---

## Problem
Two gaps in `storage` (`src/tools/storage-tools.ts:14`), both discovered by assuming they were already there:

1. **sessionStorage is write-only-by-destruction.** There is no `getSessionStorage` or `setSessionStorage`. sessionStorage appears solely as a `clear` target (`:30`, `:208-220`). The tool description reads as though sessionStorage is a peer of localStorage; it isn't.

2. **No single-key delete for localStorage.** Only whole-store `clear`. Removing one key means dropping to `evaluateExpression`.

Gap 1 bit us directly: the app under test signals a one-shot post-sign-out lock screen via a sessionStorage flag, and asserting on it isn't possible through `storage`.

## Proposed
- `getSessionStorage({ key? })` / `setSessionStorage({ key, value })`, mirroring the localStorage pair
- `removeLocalStorage({ key })` / `removeSessionStorage({ key })`, or a shared `remove({ target, key })`

## Notes
Small and mechanical. Worth doing alongside feature-011 since it's the same tool and the same "reach for evaluateExpression instead" workaround.

<!-- comment: 2026-07-26T02:59:50.805Z -->
Starting work on this now, alongside feature-011 (same file, overlapping lines).

Plan for `src/tools/storage-tools.ts`:
- Add `getSessionStorage` / `setSessionStorage`, mirroring the existing localStorage pair exactly (same `page.evaluate` + `executeWithPauseDetection` shape as `getLocalStorage`).
- Add single-key delete as `removeLocalStorage` / `removeSessionStorage` rather than a shared `remove({target,key})` — the tool's every other action already names its store in the action name, so a `target` param would be the only one of its kind and would read worse in a sequence diff.
- Fix the tool description so sessionStorage is actually described as a peer of localStorage instead of only a `clear` target.
- New success message codes go into `docs/messages.md`.

<!-- comment: 2026-07-26T03:14:30.446Z -->
Implemented.

**Files touched:** `src/tools/storage-tools.ts`, `src/tools/storage-tools.test.ts` (new), `docs/messages.md`.

**Actions added:** `getSessionStorage({key?})`, `setSessionStorage({key,value})`, `removeSessionStorage({key})`, `removeLocalStorage({key})`. Each mirrors its localStorage counterpart and goes through `page.evaluate` inside `executeWithPauseDetection`, same as `getLocalStorage`. The tool description now presents sessionStorage as a peer of localStorage rather than only a `clear` target.

**Judgement calls / notes beyond the issue text:**
- Went with `removeLocalStorage` / `removeSessionStorage` rather than a shared `remove({target,key})`. Every other action in this tool names its store in the action name, so a `target` param would be the only one of its kind.
- The remove actions report whether the key was actually present (`... (key was not present)`), so a sequence step that silently no-ops is visible instead of looking like a success. Removing an absent key is still a success, not an error.
- `key` is now `string | number` (widened for IndexedDB keys in feature-011); the Web Storage paths coerce with `String(key)`, so behaviour there is unchanged.
- New message codes in `docs/messages.md`: `SESSION_STORAGE_SET_SUCCESS`, `STORAGE_KEY_REMOVED`.

**Tests:** covered in `src/tools/storage-tools.test.ts` — read whole store, read one key, missing key reported as `null` (not an error), write isolation between sessionStorage and localStorage, single-key removal from each store leaving siblings intact, removing an absent key, and the missing-parameter errors. 44 tests in the file pass; `npx tsc --noEmit` is clean.

**Nothing in the issue turned out to be wrong** — both gaps were exactly as described. One thing worth knowing for whoever writes the sequence: the test environment has no usable `localStorage`/`sessionStorage` (happy-dom does not provide them and Node's experimental one has no `clear`), so the tests install their own Web Storage shim on `globalThis`.

**Not done (outside my file scope this round):** `docs/instructions.md:171` and `skills/cdp-tools/references/tool-categories.md:45` still list the old storage action set and are now stale.

<!-- comment: 2026-07-26T03:50:30.132Z -->
Review follow-up touching the sessionStorage work (finding 5), plus the shared serializer fix (finding 3) recorded in full on #11.

**Finding 5 - `setSessionStorage` could not write an empty string, and rejected key `0`.** The validation used `if (!args.value)` / `if (!args.key)`, so `setSessionStorage({key:'flag', value:''})` came back as MISSING_PARAMETER and a numeric key `0` was refused. Clearing a flag by setting `''` is a normal operation, and this is the exact sessionStorage-vs-localStorage parity the feature was about. Switched to `=== undefined` for:
- `setSessionStorage` (key and value)
- `setLocalStorage` (key and value) - same one-line defect, inherited rather than new
- `setCookie` (value)
- `removeLocalStorage` / `removeSessionStorage` (key)

This matches what the IndexedDB checks in the same handler already did correctly. `setCookie`'s `name` check stays `!args.name` on purpose: an empty cookie name is not a meaningful value.

**Also in this file (details on #11):** `describeStructuredValue` gained total `maxNodes`/`maxTotalChars` budgets with explicit `{__type:'BudgetExceeded'}` markers (the per-container `maxItems` and per-path `maxDepth` multiplied rather than bounded - a shared-reference structure was ~500^6 nodes and pinned the page's main thread), a `maxStringLength` cap on individual strings, and a guarded `Object.prototype.toString.call`.

**Tests:** `src/tools/storage-tools.test.ts` now 52 passing, including empty-string and zero-key round trips for sessionStorage, localStorage and cookies, and a real compounding shared-reference structure asserted to stop in bounded time. `npx tsc --noEmit` clean. Not committed.
