---
github: 98
id: 11
type: feature
status: acknowledged
title: "storage: add IndexedDB read and write actions"
startUrl: "about:blank"
recordingName: "manual"
reportedAt: 2026-07-26T02:30:36.000Z
acknowledgedAt: 2026-07-26T02:30:36.000Z
---

## Problem
The `storage` tool has no IndexedDB support. Its action enum (`src/tools/storage-tools.ts:14`) is exactly:

```
'getCookies' | 'setCookie' | 'getLocalStorage' | 'setLocalStorage' | 'clear'
```

`grep -rn "indexedDB" src/` returns nothing.

Any app that keeps meaningful state in IndexedDB — which is most offline-capable apps — forces every sequence to hand-roll the same promise-wrapping blob inside `inspect({action:'evaluateExpression'})`. A real example from a sequence in another repo, as a single line:

```js
(async () => { const db = await new Promise((res, rej) => { const r = indexedDB.open('step'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); ... })()
```

That is copy-pasted across sequences, unreadable in a diff, and breaks silently when a store or key name changes.

## Proposed
Add actions along the lines of:

- `idbGet({ db, store, key })`
- `idbGetAll({ db, store, limit? })`
- `idbPut({ db, store, value })`
- `idbDelete({ db, store, key })`
- `idbListDatabases()` / `idbListStores({ db })`
- IndexedDB as a target for the existing `clear` action

## Notes
One thing to decide deliberately: **structured-clone values that don't survive JSON**. Our motivating case stores a non-extractable `CryptoKey` in IndexedDB — a read has to report *that a key exists* without being able to serialize it. Returning something like `{__type:'CryptoKey', algorithm, extractable, usages}` rather than `{}` or an error would make it usable for identity assertions.

Same applies to `Blob`, `File`, `ArrayBuffer`, `Map`/`Set`, and cyclic objects.

This is the highest-leverage item of the batch — it's generally useful, independent of the multi-device work, and deletes real boilerplate today.

<!-- comment: 2026-07-26T02:59:45.532Z -->
Starting work on this now, together with feature-012 (same file, same lines).

Plan for `src/tools/storage-tools.ts`:
- New actions: `idbListDatabases`, `idbListStores`, `idbGet`, `idbGetAll`, `idbPut`, `idbDelete`; plus `indexedDB` added to the `clear` action's `types` enum.
- New params: `db`, `store`, `limit`, `record` (the JSON-expressible value for `idbPut`); `key` widened to string|number for IDB keys.
- All IDB work goes through one in-page `page.evaluate` wrapped in `executeWithPauseDetection`, matching the existing `getLocalStorage` pattern.
- Structured-clone problem: values are run through a self-contained in-page serializer that emits typed descriptors instead of `{}` — `{__type:'CryptoKey', algorithm, extractable, usages, keyType}` and analogues for Blob/File/ArrayBuffer/TypedArray/Map/Set/Date/RegExp/Error/BigInt, with depth and cycle guards. This is the point of the feature: you can assert that a non-extractable key exists and what it is, without being able to read it.
- The serializer is written as a pure, dependency-free function exported from the module and injected into the page via its source string, so it can be unit-tested in Node without a browser.
- `idbPut` will accept JSON-expressible values only; the tool description will say so explicitly (you cannot round-trip a CryptoKey back in).

<!-- comment: 2026-07-26T03:14:19.038Z -->
Implemented.

**Files touched:** `src/tools/storage-tools.ts`, `src/tools/storage-tools.test.ts` (new), `docs/messages.md`.

**Actions added:** `idbListDatabases`, `idbListStores({db})`, `idbGet({db,store,key})`, `idbGetAll({db,store,limit?})` (default limit 50, reports `showing N of M`), `idbPut({db,store,record,key?})`, `idbDelete({db,store,key})`. `clear` now accepts `indexedDB` in `types`. New params: `db`, `store`, `record`, `limit`; `key` widened to `string | number`.

**Structured clone:** exported `describeStructuredValue(value, {maxDepth=6, maxItems=500})`. Emits `{__type:'CryptoKey', keyType, algorithm, extractable, usages}`, `Blob`/`File`, `ArrayBuffer`/`SharedArrayBuffer`, typed arrays (with a 16-element preview), `DataView`, `Map`, `Set`, `Date`, `RegExp`, `Error`, `BigInt`, `Symbol`, `Function`, `NaN`/`Infinity`, `undefined`, plus `{__type:'Circular', path}`, `{__type:'MaxDepth'}` and truncation markers. Class instances carry `__class`. Output is always JSON.stringify-safe. It is stringified into the page and eval'd there, so it has no closure dependencies — there is a test that rebuilds it via `new Function` to keep it that way.

**Judgement calls / things that contradict or extend the issue as written:**
- `indexedDB` is NOT in the default `clear` set. `clear` with no `types` still means cookies + localStorage + sessionStorage; wiping IndexedDB has to be asked for by name. Deleting a whole database is much less recoverable than clearing a key-value store, and the existing default was already implicit.
- Opening a database that does not exist silently *creates* it in the browser. A read must not do that, so the code detects `onupgradeneeded`, closes and deletes the accidental database, and returns `Database "x" does not exist` instead.
- `deleteDatabase` never settles while another connection is open, so the `clear` path bounds each delete at 3s and reports the survivors as blocked rather than hanging the tool.
- Transaction settle handlers are attached at transaction creation, not after the requests: a read-only transaction can auto-commit before the awaits finish, and a late handler never fires (that would have been a hang).
- `idbPut` refuses two shapes rather than guessing: passing `key` to a store with a `keyPath`, and omitting `key` for an out-of-line store without `autoIncrement`.
- `record` is `z.any()` and JSON-expressible only — documented in both the parameter description and the tool description, which points at `inspect({action:'evaluateExpression'})` for creating structured-clone-only values in-page.
- New message codes in `docs/messages.md`: `IDB_PUT_SUCCESS`, `IDB_DELETE_SUCCESS`, `INDEXEDDB_ERROR`.

**Tests:** 44 in `src/tools/storage-tools.test.ts`, all passing; `npx tsc --noEmit` clean. The serializer is tested directly (real non-extractable ECDSA `CryptoKey` from `crypto.subtle`, Blob/File, ArrayBuffer/typed arrays/DataView/BigInt64Array, Map/Set with object keys, nesting, self- and mutual cycles, cycles through arrays/Maps/Sets, DAG-vs-cycle, maxDepth, maxItems, null-prototype objects, throwing getters). The IndexedDB actions are driven end-to-end against a small in-memory IndexedDB installed on `globalThis` — including the motivating case: a `CryptoKey` stored in a fake IDB comes back through `idbGet` as a descriptor, where `JSON.stringify` of the same key gives `{}`.

**Not done (outside my file scope this round):** `docs/instructions.md:171` and `skills/cdp-tools/references/tool-categories.md:45` still list the storage action set as `getCookies, setCookie, getLocalStorage, setLocalStorage, clear` and are now stale.

<!-- comment: 2026-07-26T03:50:19.205Z -->
Review follow-up (finding 3 + finding 5) applied to `src/tools/storage-tools.ts`.

**Finding 3 - unbounded work / unbounded response in `describeStructuredValue`.**
Review found that `maxItems=500` is per-container and `maxDepth=6` is per-path, so they multiply instead of bounding: shared references are deliberately re-serialized (DAG, not cycle), so an array of 500 elements each pointing at the same 500-element array is ~500^6 visited nodes. Measured on a scaled-down version of exactly that shape (width 9, 6 levels = 531,441 nodes): 209 ms and a 7.5 MB JSON result. At width 500 that is ~1.5e16 nodes - the page's main thread is pinned until the protocol call times out. No hostile input needed; a normalized cache with shared sub-objects gets there.

Fixed with TOTAL budgets threaded through the recursion, all self-contained (the function is stringified into the page, and the `new Function` round-trip test still passes):
- `maxNodes` (default 10000) - counter incremented on every `describe()` call; all work happens inside a `describe()` call, so gating at its entry bounds the whole walk. Container loops also `break` once the budget trips instead of spinning over `maxItems`.
- `maxTotalChars` (default 250000) - charges string lengths, object key lengths and a small per-value overhead.
- Truncation is explicit, never silent: an inline `{__type:'BudgetExceeded', limit:'maxNodes'|'maxTotalChars'}` marker where it stopped, plus `__budgetExceeded` on the top-level result (or a pushed marker element if the top level is an array), so a caller can tell a truncated read from a complete one.
- Same 500-wide/6-level structure now returns in ~5 ms.

**Strings were passing through uncapped** (only typed arrays had a 16-element preview), so a single 50 MB string in a record went verbatim into the MCP response. Now capped at `maxStringLength` (default 10000) and returned as `{__type:'String', length:<real length>, truncated:true, value:<prefix>}`. Short strings still pass through unchanged.

**`Object.prototype.toString.call(v)` was unguarded**, so a value with a throwing `Symbol.toStringTag` getter aborted the entire read via the outer catch. Now wrapped in try/catch falling back to `''`.

Tool description updated so the caller knows these markers exist.

**Finding 5 - could not write an empty string / a zero key.** `setCookie`/`setLocalStorage`/`setSessionStorage` used `if (!args.value)` and the set/remove paths used `if (!args.key)`, so `setSessionStorage({key:'flag', value:''})` returned MISSING_PARAMETER and key `0` was rejected. Clearing a flag with `''` is a normal operation. All switched to `=== undefined`, matching what the IndexedDB checks already did correctly. Fixed on the older `setLocalStorage`/`setCookie` too since it is the same one-line defect. `setCookie`'s `name` check is left as `!args.name` deliberately - an empty cookie name is not a meaningful value.

**Tests** (`src/tools/storage-tools.test.ts`, 52 passing): new `describeStructuredValue - total budgets` block builds the real compounding shared-reference structure (6 levels x 500) and asserts it completes in bounded time with a `BudgetExceeded` marker naming the budget; plus a lowered-`maxNodes` case, a `maxTotalChars` case, an "ordinary record is untouched and unflagged" control, a 50 KB string cap case, and a throwing-`Symbol.toStringTag` case. For finding 5, empty-string and zero-key round trips for sessionStorage/localStorage/cookie are asserted end to end.

`npx tsc --noEmit` clean; `npx vitest run src/tools/storage-tools.test.ts` 52/52 pass. Not committed.
