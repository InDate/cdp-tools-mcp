---
github: 94
id: 7
type: bug
status: acknowledged
title: "Chrome user-data-dir temp profiles are never deleted"
startUrl: "about:blank"
recordingName: "manual"
reportedAt: 2026-07-26T02:30:36.000Z
acknowledgedAt: 2026-07-26T02:30:36.000Z
---

## Steps to reproduce
Launch and kill Chrome instances repeatedly (`launchChrome` → `killChrome`), then look in the OS temp directory for `chrome-debug-profile-*`.

## Expected
The temp profile is removed when its Chrome instance is killed, or at latest on server shutdown.

## Actual
`src/chrome-launcher.ts:261` creates `chrome-debug-profile-${Date.now()}` under `os.tmpdir()`, and nothing ever removes it. There is no `rm`/`rmSync`/cleanup anywhere in `chrome-launcher.ts`, including in `kill` (`:503`) and `killInstance` (`:520`).

Chrome profiles are not small — they accumulate indefinitely across sessions.

## Notes
Worse with multi-instance work: a test that launches three Chromes per run leaks three profiles per run.

Deleting on kill is the obvious fix, though it needs care if a crashed-but-not-reaped Chrome might still hold the directory. A sweep of stale `chrome-debug-profile-*` dirs at startup would cover the crash case.

<!-- comment: 2026-07-26T02:59:21.435Z -->
Starting work (agent, scope limited to `src/chrome-launcher.ts` + a new `src/chrome-launcher.test.ts`).

Plan:
1. Add a `port -> { dir, ephemeral }` map, populated in `performLaunch`. The `ephemeral` flag exists because issue 13 (named persistent Chrome profiles) will introduce profile dirs that must survive kills — only `ephemeral: true` dirs are ever removed.
2. Remove the dir in `killInstance` after the exit wait, and also from the Chrome `exit` handler so externally-closed/crashed instances get cleaned too (with an identity check so a relaunch on the same port can't have its fresh dir deleted by a late exit event).
3. Sweep stale `chrome-debug-profile-*` dirs at construction time, guarded so we never delete a dir belonging to a live Chrome: skip if the profile's `SingletonLock` symlink names a live PID, and skip anything younger than a configurable max age (default 1h) so a concurrently-starting instance from another MCP process is never touched.

Constructor gains optional options (profileRoot / sweep toggle / max age) with defaults, so `new ChromeLauncher()` in `src/index.ts` is unchanged — I'm not touching that file.

<!-- comment: 2026-07-26T03:04:36.575Z -->
Fixed (in working tree, not yet committed).

**Changed** — `src/chrome-launcher.ts` (only file touched besides the new test):
- New `ChromeProfileRecord { dir, ephemeral }` + `profileDirs: Map<number, ChromeProfileRecord>`, populated in `performLaunch`. The `ephemeral` flag is the hook for issue 13: persistent/named profiles will be registered with `ephemeral: false` and every cleanup path skips them.
- New `ChromeLauncherOptions` on the constructor (`profileRoot`, `sweepStaleProfilesOnStartup`, `staleProfileMaxAgeMs`), all optional — `new ChromeLauncher()` in `src/index.ts` is unchanged.
- `removeProfileDir(port, expected?)`: untracks and `fs.promises.rm(..., { recursive: true, force: true })` the dir, but only when `ephemeral`. The optional `expected` record guards against a late exit event from a previous Chrome deleting the fresh profile of a relaunch on the same port.
- Cleanup is wired into three places: `killInstance` after the exit wait (both early-return paths too, so a profile whose process was already reaped still gets removed); the Chrome `exit` handler (covers external closes and crashes, which `killInstance` never sees); and the `waitForChromeReady` failure path in `performLaunch` (a failed launch no longer leaks a profile).
- `sweepStaleProfiles()` runs at construction (result exposed as `startupSweep` for tests). It only considers dirs named `chrome-debug-profile-*` under the profile root and skips a dir if it is currently tracked, if its mtime is younger than `staleProfileMaxAgeMs` (default 1h — a concurrently-launching MCP instance must not have its profile deleted), or if its Chrome `SingletonLock` symlink names a PID that is still alive.
- `reset()` now untracks profiles but deliberately does **not** delete them: reset is a "forget my state" escape hatch and the Chrome may still be running. Anything orphaned that way is picked up by the next startup sweep.
- New accessors `getProfileDir(port)` / `getProfiles()`.

**Tests added** — `src/chrome-launcher.test.ts`, 17 tests, all passing, no real Chrome spawned (fake ChildProcess + temp profile root). Cleanup-side coverage: kill deletes the profile; `kill()` with no port cleans all instances; already-reaped process still cleaned; **persistent profile survives a kill**; late-exit identity guard; `reset()` keeps the dir; sweep removes old dirs / keeps fresh ones / ignores non-`chrome-debug-profile-*` dirs / skips live-`SingletonLock` dirs / removes dead-`SingletonLock` dirs / never touches an in-use dir / runs on construction / tolerates a missing root.

**Verification**: `npx vitest run src/chrome-launcher.test.ts` 17/17 pass; `npx tsc --noEmit` clean for this file (remaining errors in the tree are in `src/tools/storage-tools.ts`, another agent's in-flight work). `npm run build` / full `npm test` intentionally not run — two other agents are working in the same tree.

**Notes / judgement calls that go beyond the report**:
- The report only asks for deletion on kill; I also delete from the `exit` handler, because `killChrome` is not how most instances die (user closes the window, inactivity, crash) and those were the bigger leak.
- The startup sweep is deliberately conservative (1h age floor + lock check). Consequence: a profile from a Chrome that crashed less than an hour ago survives until the *next* server start. That is the right trade — several MCP instances can share `os.tmpdir()`, and an over-eager sweep would corrupt a live browser session.
- The `SingletonLock` check is POSIX-only (Windows uses a plain lock file); on Windows the age floor is the only guard. Acceptable, since the sweep only ever removes hours-old dirs.

<!-- comment: 2026-07-26T04:08:46.265Z -->
## Review follow-up: closed the in-process profile deletion races

**Review found:** `killInstance()` called `removeProfileDir(port)` with **no `expected` record** on all three paths (the two early returns and the final cleanup). The exit handler already had the identity guard, but these did not - so a `killChrome` overlapping a relaunch on the same port could delete the *new* launch's fresh profile. The window is between `profileDirs.set()` and `chromeProcesses.set()` in `performLaunch()`.

**Changed (src/chrome-launcher.ts):** `killInstance()` snapshots `profileDirs.get(port)` at entry, before any await, and passes that snapshot as `expected` to every `removeProfileDir()` call. Once a newer launch owns the port the record identity differs and the deletion becomes a no-op. When nothing is tracked at entry (snapshot undefined) the deletion is skipped entirely rather than falling back to "delete whatever is there now" - same reasoning.

**Also fixed (related race, same issue family):** two near-simultaneous `launch()` calls for the same *named profile* both passed the guards, because `findPortForProfile()` requires `isRunning(port)` which is false for the whole spawn window; Chrome then handed the second process off to the first singleton and it died as a generic spawn failure. `launch()` now serialises by profile name via `profileLaunchLocks`, following the existing per-port `launchLocks` pattern. Same-port + same-profile duplicates still get the hand-off (both callers receive the one launch result); a different port loses with `ProfileInUseError`.

**Tests (src/persistent-profiles.test.ts):**
- kill in flight + a relaunch claiming the port mid-kill -> the new profile dir survives and stays tracked. Verified this test **fails** against the pre-fix code (`removeProfileDir(port)` with no `expected`).
- kill with nobody else claiming the port still deletes its own ephemeral profile (no regression to bug-007 cleanup).
- kill of a port whose process was already reaped still cleans up the tracked profile (early-return path).
- concurrent same-profile launches serialise (verified failing pre-fix); concurrent different-profile launches still run in parallel.

`tsc --noEmit` clean; 71 tests pass across chrome-launcher / persistent-profiles / launch-chrome-port.

Not resolving - agents cannot verify.
