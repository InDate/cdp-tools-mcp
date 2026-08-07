---
github: 93
id: 6
type: bug
status: acknowledged
title: "Chrome user-data-dir names collide when two instances launch in the same millisecond"
startUrl: "about:blank"
recordingName: "manual"
reportedAt: 2026-07-26T02:30:36.000Z
acknowledgedAt: 2026-07-26T02:30:36.000Z
---

## Steps to reproduce
Launch two Chrome instances concurrently on different ports, e.g. two parallel `launchChrome({ forceNewInstance: true })` calls.

## Expected
Each spawned Chrome gets its own isolated profile directory.

## Actual
`src/chrome-launcher.ts:261`:

```ts
const userDataDir = path.join(os.tmpdir(), `chrome-debug-profile-${Date.now()}`);
```

The directory name is keyed on millisecond time only. Two spawns landing in the same millisecond get the same `--user-data-dir` (`:269`) and therefore share cookies, localStorage and IndexedDB.

`launchLocks` (`:30`, `:206-227`) serializes launches only on the *same* port, so concurrent launches on *different* ports — exactly the multi-instance case — are not protected.

## Notes
Narrow window, but the failure mode is nasty and silent: the whole point of `forceNewInstance` is storage isolation, and when it collides you get two "devices" sharing one identity with no error.

Adding a counter or random suffix to the directory name would close it.

Surfaced while designing a multi-device test where device identity is a non-extractable WebCrypto key in IndexedDB — profile isolation is what makes the devices distinct.

<!-- comment: 2026-07-26T02:59:14.411Z -->
Starting work (agent, scope limited to `src/chrome-launcher.ts` + a new `src/chrome-launcher.test.ts`).

Plan: replace the `chrome-debug-profile-${Date.now()}` name in `performLaunch` with a name that is unique by construction even for same-millisecond launches: `chrome-debug-profile-p<port>-<timestamp>-<8 hex random>`. Port is already unique per concurrent launch (two live Chromes cannot share a debug port), and the random suffix additionally covers sequential relaunches on the same port within a millisecond. This is deliberately *not* solved by widening `launchLocks`, since that lock is per-port by design and serialising all launches globally would slow multi-instance launches.

Fixed together with bug-007 (profile tracking/cleanup) since both touch the same lines.

<!-- comment: 2026-07-26T03:04:18.079Z -->
Fixed (in working tree, not yet committed).

**Changed** — `src/chrome-launcher.ts`:
- New private `createProfileRecord(port)` builds the profile dir name as `chrome-debug-profile-p<port>-<Date.now()>-<8 hex random>` and returns a `{ dir, ephemeral }` record. `performLaunch` now calls it instead of inlining `chrome-debug-profile-${Date.now()}`.
- Profile root is now a field (`profileRoot`, defaults to `os.tmpdir()`) so it can be pointed at a temp dir in tests.

**Tests added** — `src/chrome-launcher.test.ts` (17 tests, all passing, no real Chrome spawned):
- 4 ports' worth of records generated inside a single millisecond are all distinct (this is the test that fails against the old `Date.now()`-only name).
- 200 records for the *same* port are all distinct.
- Name contains `p<port>-`, dir sits under the configured root, `ephemeral === true`.

**Verification**: `npx vitest run src/chrome-launcher.test.ts` 17/17 pass; `npx tsc --noEmit` clean for this file (the only remaining errors in the tree are in `src/tools/storage-tools.ts`, which another agent is editing right now).

**Contradicting the report as written**: the report suggests widening `launchLocks`. That is not needed and I did not do it. Two Chromes cannot share a remote-debugging port, and `launch()` already rejects/joins a second launch on the same port, so the port alone makes concurrent profile dirs unique; the random suffix is belt-and-braces for *sequential* relaunches on the same port inside one millisecond. Serialising launches globally would have made multi-instance launches slower for no isolation benefit.
