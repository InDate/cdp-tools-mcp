---
id: 3
type: bug
status: acknowledged
title: "issues resolve deadlocks autonomous agents: interactive verification with no timeout"
labels: ["issues", "agents", "deadlock", "chrome-launcher"]
startUrl: "about:blank"
recordingName: "manual"
reportedAt: 2026-07-25T15:50:00.000Z
acknowledgedAt: 2026-07-25T15:50:00.000Z
---

## Summary

`issues({ action: "resolve", id: N })` opens an interactive human-verification flow. When called by an autonomous agent with no human watching, it blocks indefinitely, then fails with a protocol timeout. The calling agent is left wedged and produces no output at all.

Observed for real: a subagent completed its entire task, ran typecheck and lint clean, emitted "All four tasks plus issue #20 are complete and verified. Here's my final report:", then called `resolve` on two issues and hung. It sat wedged for roughly 25 minutes until killed. **Its final report was never written**, so all of its findings, measurements and caveats were lost. Only the one-line preamble survived, in its transcript.

## Steps to reproduce

1. From an autonomous agent context (no human able to respond in the browser), call:
   `issues({ action: "resolve", id: <existing issue id>, keepBrowserOpen: false })`
2. Observe the call does not return.
3. After roughly 3 minutes it fails with:
   `Runtime.callFunctionOn timed out. Increase the 'protocolTimeout' setting in launch/connect calls for a higher timeout if needed.`
4. The agent does not recover and emits nothing further.

Timeline from the captured transcript:

```
15:39:18  assistant  TEXT "Both clean. All four tasks plus issue #20 are complete and verified..."
15:39:19  assistant  TOOL mcp__cdp-tools__issues {"action":"resolve","id":5,"keepBrowserOpen":false}
15:39:19  assistant  TOOL mcp__cdp-tools__issues {"action":"resolve","id":20,"keepBrowserOpen":false}
15:42:19  user       RESULT "Runtime.callFunctionOn timed out..."
(no further entries; transcript static at 467 lines)
```

## Why this is worse than a normal tool failure

- **Silent and total.** The agent's work was finished and on disk, but its report — including everything it verified, chose, and could not verify — was destroyed. A coordinator gets no signal beyond "still running".
- **Hard to diagnose.** The agent looks alive: no error surfaces to the orchestrator, and file mtimes give no clue (see the related finding below about `stat` reporting a stale size on the running transcript).
- **Attractive nuisance.** `resolve` reads as bookkeeping. Nothing in its description signals that it opens a browser and waits for a human, so an agent picks it up believing it is recording a state change.

## Design intent (important — do not "fix" this the wrong way)

**The interactive, human-in-the-loop nature of `resolve` is correct and should be preserved.** Closing an issue is a human judgement: a person verifies the fix and then closes it. Agents must never close issues, including issues covering their own work — an agent marking its own output verified is exactly the failure this flow exists to prevent.

So the fix is NOT to add a non-interactive or "skip verification" mode. That would hand agents the ability to close their own issues and defeat the purpose of the feature. The bug here is narrow: **when an agent invokes `resolve`, it should fail immediately and return, instead of blocking on a prompt nobody will answer.**

## Suggested fix

1. **Detect a non-interactive caller and fail fast.** If there is no human-attended client able to answer the verification prompt, return immediately with a clear typed error, e.g.

   ```
   ISSUES_RESOLVE_REQUIRES_HUMAN
   "resolve requires human verification and cannot be called by an agent.
    Ask the user to verify and close issue #N. Use action 'comment' to record findings."
   ```

   Immediate, deterministic, and it tells the agent what to do instead. The agent then finishes its turn and reports normally, which is all that was needed here.

2. **Never mark the issue resolved on that path.** The state change belongs to the human, so the failure must be a genuine no-op.

3. **Bound the interactive path too.** Even with a real human, the current failure mode is a raw Puppeteer `Runtime.callFunctionOn timed out` after roughly 3 minutes. If a human simply walks away, that should surface as a typed, actionable error rather than a protocol timeout leaking through.

4. **Document it in the tool description.** `resolve` is currently described as "mark as fixed/implemented", which reads as inert bookkeeping. That is why agents reach for it. It should say plainly that resolution requires human verification and is not available to agents.

The invariant worth encoding: **`resolve` is a human-only action; every other caller gets an immediate, explicit refusal.**

## Related findings from the same session

These are separate defects, listed here because they were found together and share a theme of failures being invisible. Split into their own issues if preferred.

**(a) `launchChrome` silently ignores the requested port.**
`launchChrome({ reference: "...", port: N, forceNewInstance: true })` does not honour `port` — Chrome comes up on a different, launcher-chosen port, with no warning in the result. This broke deliberate port allocation across five concurrently running agents, each of which had been assigned a distinct port specifically to avoid collisions. Either honour the port, or return an explicit error, or state the actual port prominently in the result.

**(b) Chrome is launched with `stdio: 'ignore'`, hiding Chrome's own diagnostics.**
This masked a genuine root cause for a long time. `--use-file-for-fake-audio-capture` silently produced pure silence because Chrome's audio-service utility process is sandboxed on macOS. Chrome logs the reason and even names the fix:

```
ERROR:media/audio/simple_sources.cc:35] Failed to read <path> as input to the fake device.
Try disabling the sandbox with --no-sandbox.
```

Nobody could see it. The cause was only found by launching Chrome manually with `--enable-logging=stderr --v=1` outside cdp-tools. Suggested fix: capture Chrome's stderr to the existing per-instance log files (the `server` tool already does this for dev servers), and surface recent Chrome-level errors in tool results when something fails.

**(c) `--no-sandbox` passed via `chromeArgs` causes `chromeArgs` to be dropped entirely.**
Verified by reading the spawned process's real command line: passing `--no-sandbox` results in a Chrome process with none of the supplied `chromeArgs`, rather than an error. If the flag is deliberately blocked by policy, that should be an explicit, documented rejection naming the flag — not the silent loss of every argument.

## Environment

- cdp-tools MCP as configured for the project at `/Users/joshua/Documents/Code/music`
- macOS (darwin 25.3.0)
- Encountered 25 July 2026 while orchestrating several concurrent autonomous agents
