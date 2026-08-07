---
github: 92
id: 5
type: bug
status: acknowledged
title: "launchChrome silently discards an explicit port when forceNewInstance is set"
startUrl: "about:blank"
recordingName: "manual"
reportedAt: 2026-07-26T02:30:36.000Z
acknowledgedAt: 2026-07-26T02:30:36.000Z
---

## Steps to reproduce
```
launchChrome({ reference: "device-a", port: 9223, forceNewInstance: true })
```

## Expected
Either Chrome launches on 9223, or the call errors saying `port` and `forceNewInstance` are mutually exclusive.

## Actual
`src/index.ts:335-340`:

```ts
let port = args.port || configManager.getCurrentPort();
if (args.forceNewInstance) {
  port = await findAvailablePort(configManager.getChromeConfig().startingDebugPort);
}
```

The requested port is overwritten with whatever `findAvailablePort` returns, scanning up from `startingDebugPort`. No warning, no error. The caller gets a working Chrome on an unexpected port, which only shows up later when they try to reason about which instance is which.

Related, same block: `forceNewInstance` skips the reference-reuse path at `:348`, so passing an existing `reference` alongside it yields a second Chrome bound to the same reference name rather than reusing the first.

## Notes
Found while designing a multi-device browser test where each simulated device is its own Chrome instance on a known port. Pinning ports per device is the natural way to keep them straight, and it silently doesn't work.

Fix could be: honour the explicit port and only fall back to `findAvailablePort` when `port` is absent; or reject the combination outright. Either is fine — the silent override is the problem.

<!-- comment: 2026-07-26T03:01:43.744Z -->
Starting work on this (agent, scoped to the `launchChrome` schema/handler in `src/index.ts` + `docs/messages.md`).

Plan — decision already made upstream, recording it here:
1. **Honour an explicit `port` even with `forceNewInstance`.** Instead of silently reassigning via `findAvailablePort`, check whether that port is already in use (`connectionManager.hasBrowser` / `chromeLauncher.isRunning` / port probe). If it is, fail with a clear error rather than tabbing into the existing Chrome — that preserves the guarantee the current override was written for (comment at :337-339) without the silent surprise. When no explicit `port` is given, `forceNewInstance` keeps today's find-a-free-port behaviour.
2. **Fix the reference double-bind at :348.** `forceNewInstance` currently skips the reference-reuse check entirely, so a second Chrome can bind the same reference. A reference already bound to a *live* instance will now error instead of silently double-binding.

New error codes get added to `docs/messages.md` in the existing format. Will verify with `npx tsc --noEmit` plus a targeted vitest file (not a full build — other agents are in this tree).

<!-- comment: 2026-07-26T03:04:39.912Z -->
Fix implemented (not committed — left in the working tree for review).

**What changed**

`src/index.ts` (launchChrome schema + handler only):
1. **Explicit port is now honoured under `forceNewInstance`.** `args.port` is captured as `explicitPort`; the `findAvailablePort` fallback now only runs in the `else` branch (no explicit port), preserving today's behaviour there. When an explicit port *is* given with `forceNewInstance`, the port is checked for occupancy via `connectionManager.hasBrowser('localhost', port) || chromeLauncher.isRunning(port) || isPortHeldByOther(port)` and the call returns `CHROME_FORCED_PORT_IN_USE` if taken. This keeps the guarantee the old override was written for (never tab into an existing Chrome) without the silent relocation.
2. **`isPortHeldByOther`** is a small local probe that binds `127.0.0.1:<port>` with `net.createServer`; any bind failure counts as occupied. It deliberately returns `false` when the port is *our own* `portReserver` reservation, mirroring the `isOurReservation` logic in `chrome-launcher.ts:performLaunch` — otherwise passing the session's reserved port explicitly would have falsely errored.
3. **Reference double-bind fixed.** The reference lookup at the old `:348` is no longer gated on `!args.forceNewInstance`. It always runs; if a live connection already holds the reference and `forceNewInstance` is set, the call returns `CHROME_REFERENCE_ALREADY_BOUND` instead of creating a second Chrome under the same name. Dead connections still get auto-cleaned by `findConnectionByReferenceValidated`, so a stale reference is reusable as before.
4. Schema descriptions for `port` and `forceNewInstance` updated to state the new semantics.

`docs/messages.md`: two new templates in the Connection Messages section — `CHROME_FORCED_PORT_IN_USE` (code `PORT_IN_USE`) and `CHROME_REFERENCE_ALREADY_BOUND` (code `REFERENCE_IN_USE`), both with actionable suggestions (killChrome, drop forceNewInstance, omit port, pick a different reference).

**Tests** — new `src/launch-chrome-port.test.ts`, 5 tests, all passing (`npx vitest run src/launch-chrome-port.test.ts`). `npx tsc --noEmit` is clean for `index.ts` (the only remaining errors are in `src/tools/storage-tools.ts`, which another agent is editing concurrently).

**Caveat on the tests, stated plainly:** the `launchChrome` handler is not unit-testable as it stands — it is an inline closure inside `src/index.ts`, which calls `main()` at import and needs a real Chrome. So the tests cover (a) that the two new message templates exist and interpolate (a missing template degrades silently to "Error: Message not found"), and (b) a source-shape guard that `findAvailablePort` sits only in the no-explicit-port branch and that the `!args.forceNewInstance` gate on the reference lookup is gone. That is a regression tripwire, not end-to-end proof. Real coverage would need the handler extracted from `index.ts` — out of scope for this change.

**Contradicting/refining the issue as written:** the issue offered "reject the combination outright" as an alternative. That was not taken — `port` + `forceNewInstance` is a legitimate and useful combination (the multi-device-on-known-ports use case in the Notes is exactly it), so it now works rather than erroring. The error only fires when the requested port is genuinely unavailable.

<!-- comment: 2026-07-26T04:08:34.476Z -->
## Review follow-up: replaced the source-grep tests with executed coverage

**Review found (test theatre):** `src/launch-chrome-port.test.ts` had 5 tests - two rendered message templates, three **grepped `src/index.ts` source** for strings like `'if (explicitPort !== undefined)'` and `"createErrorResponse('CHROME_FORCED_PORT_IN_USE'"`. None executed the occupancy decision, so bug-005's actual behaviour shipped on zero executed coverage, and the grep assertions would have passed under any future logic bug that preserved those tokens. The blocker was real: the handler is an inline closure in `src/index.ts`, which calls `main()` on import.

**Changed:**
- Extracted the decision into a pure, exported `resolveLaunchPort(req)` in `src/chrome-launcher.ts`, with `isPortOccupied` / `findFreePort` injected as callbacks. Returns `{decision:'use', port}` or `{decision:'forced-port-in-use', port}`.
- The `launchChrome` handler now just calls it and maps `forced-port-in-use` to `CHROME_FORCED_PORT_IN_USE`. Behaviour unchanged.
- `src/launch-chrome-port.test.ts` rewritten: all three grep tests are gone, replaced with 6 tests that execute the function - reserved port when no port given; explicit port honoured without probing when not forcing; free-port selection for portless `forceNewInstance`; a free explicit port honoured under `forceNewInstance` (asserting `findFreePort` was *not* consulted - that was the bug); occupied explicit port under force returns the error and does not relocate; and a matrix asserting an explicit port is never substituted in any combination. The two template-rendering tests are kept (they catch renamed/missing templates, which the executed tests cannot).

8 tests pass, `tsc --noEmit` clean.

**Note:** the handler itself still cannot be imported by a unit test (`main()` on import). The same extraction pattern was applied to the profile ordering fix (`decideProfileReuse`, see issue 13), so both branchy decisions in the handler are now covered by executed tests; what remains inline is plumbing.

Not resolving - agents cannot verify.
