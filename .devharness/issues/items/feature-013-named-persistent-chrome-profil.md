---
github: 100
id: 13
type: feature
status: acknowledged
title: "Named persistent Chrome profiles for multi-device tests"
startUrl: "about:blank"
recordingName: "manual"
reportedAt: 2026-07-26T02:30:36.000Z
acknowledgedAt: 2026-07-26T02:30:36.000Z
---

## Problem
There is no profile or device abstraction. `ConnectionManager` tracks `browsers: Map<"host:port", BrowserInstance>` (`src/connection-manager.ts:38`, `:85-93`) and knows nothing about user-data-dirs. The only way to get N isolated browsers is N `launchChrome({ forceNewInstance: true })` calls with hand-tracked ports — which additionally trips bug-005 (explicit port discarded) and bug-006 (dir-name collision).

Two consequences:

1. **Bookkeeping is manual.** Callers maintain the port↔device mapping themselves, and reference names aren't enforced unique against it.
2. **Profiles can't be reused.** The temp dir is computed inside `performLaunch` (`src/chrome-launcher.ts:261`) and is neither addressable nor nameable, so browser-persisted state cannot survive a run. Every run starts from zero.

Point 2 is the sharper one. Where identity is a non-extractable `CryptoKey` in IndexedDB, it *cannot* be injected by the test — it can only be created by driving the app's real enrolment flow. Without persistent profiles, every run must re-enrol every device before testing anything, and there's no way to write a test that begins from "this device was already signed in yesterday".

## Proposed
A named-profile concept, e.g. `launchChrome({ profile: "device-a", persist: true })`:

- maps to a stable directory under the cdp-tools data dir rather than an anonymous tmp one
- reused across launches when `persist` is set, so enrolment survives runs
- addressable for teardown (`resetProfile({ profile })`) instead of relying on `Date.now()` uniqueness
- lets `replay` address a device by profile name rather than by port

Anonymous ephemeral profiles stay the default; this is opt-in.

## Notes
Depends on bug-005 and bug-006 being fixed, or it inherits both.

Motivating case: a test where a person has two devices, one revokes itself, and the other must be unaffected. Three concurrent browsers — owner console, device A, device B — each needing its own IndexedDB, and ideally each retaining its enrolled identity between runs.

<!-- comment: 2026-07-26T03:06:57.806Z -->
**Starting implementation of named persistent profiles.**

Plan (decisions were pre-made by the parent, implementing as specified):

- `launchChrome({ profile: 'work-google' })` — naming a profile *implies* persistence, no separate `persist` flag. The profile does **not** pin a port; port selection is unchanged.
- Profile root: global `~/.cdp-tools/profiles/<name>` by default, overridable per-project via a new `chrome.persistentProfileRoot` config setting (rides the existing local/global config split rather than inventing a parallel mechanism).
- Reset is a config action: `config({ action: 'resetProfile', profile: '<name>' })` — wipe + recreate. No new top-level tool.
- Persistent profiles register with `ephemeral: false` on the `ChromeProfileRecord` that landed with bug-006/bug-007, so every existing cleanup path (killInstance, exit handler, waitForChromeReady failure, startup sweep) already leaves them alone.

Additional behaviour I'm adding for safety, will document:
- Resetting a profile currently held by a live Chrome is **refused** with a clear error (you must kill that instance first) — silently wiping a user-data-dir out from under a running Chrome corrupts it.
- Launching a named profile that another live Chrome already holds is refused (Chrome would otherwise hand the launch off to the existing process and the new one would exit).
- A persistent profile dir that doesn't exist yet is created on first use; the managed `Preferences` seed is written only when absent so relaunches don't stomp accumulated profile state.

Files: `src/chrome-launcher.ts`, `launchChrome` in `src/index.ts`, `src/tools/config-tools.ts`, `src/config.ts`, plus tests.

<!-- comment: 2026-07-26T03:22:57.164Z -->
**Implemented.**

### What landed

`src/chrome-launcher.ts`
- `PROFILE_NAME_PATTERN` + `normalizeProfileName()` — strict validation (1-64 chars, `[A-Za-z0-9][A-Za-z0-9._-]*`). Invalid names **throw** rather than being sanitised: silently renaming would hand the caller a different identity than they asked for. Rejects `..`, `/`, leading `.`/`-`, and anything starting with `chrome-debug-profile-` (which the startup sweep would eat).
- New error types `InvalidProfileNameError`, `ProfileInUseError`.
- `ChromeLauncherOptions.persistentProfileRoot?: string | (() => string)` (default `~/.cdp-tools/profiles`). The function form is what `index.ts` passes, so a live config reload of the root takes effect without restarting.
- `createProfileRecord(port, profileName?)` — with a name, returns `{dir: <root>/<name>, ephemeral: false}`. The port is deliberately **not** in the directory name, so the same profile can come up on any port.
- `performLaunch` creates the dir on first use, and seeds the managed `Preferences` file **only when absent** for persistent profiles (rewriting it every launch would throw away exactly the state the profile exists to keep).
- `launch()` gained a 6th param `profileName?` and refuses (`ProfileInUseError`) if a live Chrome already holds that profile.
- New API: `getPersistentProfileRoot()`, `getPersistentProfilePath(name)`, `findPortForProfile(name)`, `listPersistentProfiles()`, `resetPersistentProfile(name)`.

`src/config.ts`
- `chrome.persistentProfileRoot` (default `''` = global `~/.cdp-tools/profiles`), plus merge/default wiring so it round-trips through save/reload.
- `getPersistentProfileRoot()` — expands `~/`, resolves relative paths against cwd. A project-local config (`config({action:'useLocal'})`) setting this gives that project its own profile store; this rides the existing local/global split rather than adding a parallel mechanism.

`src/index.ts` (launchChrome region only)
- New `profile` arg. Name validated before anything touches the filesystem → `CHROME_PROFILE_INVALID_NAME`.
- Refuses to launch a profile another live Chrome holds → `CHROME_PROFILE_IN_USE` (also mapped from a `ProfileInUseError` thrown by the launcher, in case the race is lost).
- If Chrome is already running on the target port with a *different* profile, the call errors `CHROME_PROFILE_PORT_MISMATCH` instead of quietly tabbing into the wrong identity.
- The launcher is now constructed with a lazily-resolved persistent root from config.

`src/tools/config-tools.ts`
- `config({ action: 'resetProfile', profile })` — wipe + recreate empty. Refused while a live Chrome holds it (`CONFIG_PROFILE_RESET_IN_USE`); nothing is deleted on the way to refusing.
- `config({ action: 'listProfiles' })` — bonus discovery action, lists what exists and where the root is.
- `createConfigTools()` now takes an optional `ProfileStore` (the launcher).

### Tests
`src/persistent-profiles.test.ts` — 29 tests: name validation, stable/port-independent dirs, `ephemeral:false` (survives `kill()` and the startup sweep even when sharing the ephemeral root), function-valued root re-resolution, list/reset semantics, one-live-Chrome-per-profile, config root resolution (default/absolute/relative/`~`/reload round-trip), and the `resetProfile`/`listProfiles` tool actions. All pass; `chrome-launcher.test.ts` and `launch-chrome-port.test.ts` still pass; `tsc --noEmit` clean.

Also ran a throwaway **real-Chrome** end-to-end check (deleted afterwards): launch with `profile: 'itest-device'` → profile created → marker written into `Default/` → kill → marker survives → relaunch on a *different port* reuses the same dir with the marker intact → an anonymous launch is still ephemeral and its dir is gone after kill. Confirmed working against actual Chrome.

### Contradicting / amending the issue as written
1. **`persist: true` does not exist.** The issue proposes `launchChrome({ profile: "device-a", persist: true })`. Naming a profile *is* the persistence signal — a name plus `persist: false` has no coherent meaning (an anonymous throwaway is already the default). One flag less.
2. **`resetProfile({ profile })` is not a top-level tool.** It is `config({ action: 'resetProfile', profile })`, to avoid adding another tool to the catalogue for a rare maintenance operation.
3. **Reset while in use is refused, not forced.** Deleting a user-data-dir under a running Chrome corrupts it *and* is partly undone as Chrome flushes state on exit, so you must `killChrome({ port })` first. The error names the port holding it.
4. **"lets `replay` address a device by profile name rather than by port" is NOT implemented.** That is a replay-tools change (owned elsewhere in this work) and needs a profile→connection mapping in `ConnectionManager`; today you still address devices by `connectionReason`/reference. Worth a follow-up issue — the profile name is now a stable key it could hang off.
5. **A profile still does not pin a port** (explicit parent decision). Port selection is untouched; a profile can come up on any port. If a future caller wants "same device, same port", that is separate bookkeeping.
6. Reused-instance case: when Chrome is already up on the requested port, `profile` is *not* ignored (unlike `chromeArgs`) — a mismatch is an error, because the wrong profile means the wrong identity.

<!-- comment: 2026-07-26T04:08:23.125Z -->
## Review follow-up: cross-session profile safety + launch ordering

**Review found (BLOCKING, data loss):** `resetPersistentProfile()` only guarded with `findPortForProfile()`, which reads *this* process's `profileDirs`/`chromeProcesses`. The default profile root is global (`~/.cdp-tools/profiles`), so session B running `config({action:'resetProfile', profile:'device-a'})` saw nothing while session A had that profile live, and `rm -rf`'d the user-data-dir under a running Chrome - destroying the enrolled identity the feature exists to preserve. Same gap (lower stakes) in `launch()`'s one-live-Chrome-per-profile guard: a profile held by another process passed, the new Chrome handed off to the existing singleton and died as a generic spawn failure.

**Changed (src/chrome-launcher.ts):**
- New `ProfileLockedError` (profile, holding pid, dir) and public `findProfileLockHolder(name)`, built on the existing `SingletonLock` -> live-PID check that the startup sweep already used (`readProfileLockPid()`; `isProfileLocked()` now delegates to it).
- `resetPersistentProfile()` refuses when the lock names a live PID, *before* any deletion. Stale locks (dead PID) still reset.
- `launch()` runs the same check before spawning, so the caller gets the real reason instead of "Failed to launch Chrome".
- **Honest limitation, documented on the error class and both call sites:** the check is POSIX-only. `SingletonLock` is a symlink on macOS/Linux; Windows Chrome uses a plain lock file with no readable PID, so there it always reports "not locked" and the cross-session race remains. A negative result means "no evidence of a holder", not "free".

**Also fixed - profile pre-check ordering (regression in the most common call pattern):** in `src/index.ts` the `CHROME_PROFILE_IN_USE` pre-check ran *before* the reference-reuse lookup, so re-calling `launchChrome({profile:'x', reference:'y'})` while that Chrome was alive - the standard idempotent "make sure it's up" pattern - always errored, and the `CHROME_PROFILE_PORT_MISMATCH` success case (profile matches -> reuse) was unreachable. The decision now lives in an exported pure function `decideProfileReuse()` and is applied via one `profileGate()` helper at both decision points: a live instance already running the requested profile is reused exactly as it would be without a profile; "in use" fires only when the call would actually have to put a second Chrome on a held profile.

**Also fixed - concurrent launches of the same profile:** `launch()` now serialises by profile *name* (`profileLaunchLocks`, mirroring the existing per-port `launchLocks`). Two launches for one profile both used to pass the guard because `findPortForProfile()` needs `isRunning()`, false for the whole spawn window. Same port + same profile still gets the hand-off (both callers get the one launch); different port loses with `ProfileInUseError`.

**Tests (src/persistent-profiles.test.ts, 46 passing):** external-lock refusal for both `resetPersistentProfile()` and the `config({action:'resetProfile'})` tool with the profile data asserted intact; stale-lock still resets; `launch()` refusing a locked profile without spawning; concurrent same-profile serialisation vs concurrent different-profile launches; 7 `decideProfileReuse()` ordering cases.

**Template gap for whoever owns docs/messages.md:** `ProfileLockedError` currently renders through `CHROME_SPAWN_FAILED` (launch) / `CONFIG_PROFILE_RESET_FAILED` (reset) carrying the launcher's own explanatory message. Both existing profile templates talk in *ports*, and here we only know a PID. Suggested new templates: `CHROME_PROFILE_LOCKED_EXTERNALLY` and `CONFIG_PROFILE_RESET_LOCKED`, vars `{{profile}}`, `{{pid}}`, `{{dir}}`, suggestion text along the lines of "another cdp-tools session or a manually started Chrome is using this profile; quit it (PID {{pid}}) or use a different profile name".

Not resolving - agents cannot verify.
