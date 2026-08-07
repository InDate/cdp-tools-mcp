---
id: 4
type: bug
status: acknowledged
title: "inspect evaluateExpression hangs indefinitely when the evaluated code throws RangeError instead of returning the error"
labels: ["inspect", "agents", "deadlock", "error-handling"]
startUrl: "about:blank"
recordingName: "manual"
reportedAt: 2026-07-26T00:05:00.000Z
acknowledgedAt: 2026-07-26T00:05:00.000Z
---

## Summary

`inspect({ action: "evaluateExpression", ... })` never returns when the evaluated JavaScript throws a stack-exhaustion `RangeError`. No result, no error, no timeout — the call simply hangs and the calling agent is stuck permanently.

An evaluated expression that throws should come back as a tool error containing the exception, exactly as an ordinary runtime error does. Instead the failure mode is total silence.

## Steps to reproduce

Against any connected page:

```js
inspect({
  action: "evaluateExpression",
  connectionReason: "<your connection>",
  expression: `
    (() => {
      const a = new AnalyserNode(new AudioContext(), { fftSize: 32768 });
      const buf = new Float32Array(a.fftSize);
      // spreading a large typed array exhausts the call stack
      return JSON.stringify({ max: Math.max(...buf) });
    })()
  `
})
```

`Math.max(...buf)` with ~32k elements throws `RangeError: Maximum call stack size exceeded`. Expected: the tool returns that exception. Actual: the call never returns.

## Observed in the wild

An autonomous agent ran effectively this code to measure audio RMS from an `AnalyserNode`:

```js
return JSON.stringify({ rms, sampleMax: Math.max(...buf), sampleMin: Math.min(...buf) });
```

Transcript evidence — the tool call was issued and no result ever arrived:

```
15:57:26  assistant  TOOL mcp__cdp-tools__inspect {"action":"evaluateExpression",
                          "connectionReason":"rms-audio-test", "expression":"... Math.max(...buf) ..."}
(no corresponding result; transcript frozen at 352 lines)
00:01:34  agent killed manually, 4+ minutes later
```

The agent had completed most of its task and was on its final measurement. Because it was wedged mid-call it never produced its report, so all of its findings had to be recovered by parsing its raw transcript.

## Note on timeout behaviour — it is inconsistent

This is worth investigating alongside the hang. A *different* wedged call in the same session did eventually time out:

```
Runtime.callFunctionOn timed out. Increase the 'protocolTimeout' setting in
launch/connect calls for a higher timeout if needed.
```

That fired after roughly 3 minutes. But this `evaluateExpression` case produced nothing at all after 4+ minutes. So either the timeout does not apply on this path, or a renderer busy/blown by the failing expression prevents it from firing. Whichever it is, `evaluateExpression` currently has no reliable upper bound.

## Suggested fix

1. **Return thrown exceptions instead of hanging.** CDP's `Runtime.evaluate` reports failures via `exceptionDetails` on the response. Surface that as a normal tool error result — expression, error type, message, and stack where available. A `RangeError` from evaluated code is an ordinary outcome and should be reported, not swallowed.
2. **Apply a bounded timeout on this path.** Every `evaluateExpression` should have an upper bound and return a typed timeout error naming the connection and a truncated expression, so the caller knows which call died. It should not be possible for this action to block indefinitely.
3. **Consider `Runtime.evaluate`'s own guards.** Passing a `timeout` in the evaluate params, and `returnByValue` with a size cap, would let Chrome abort a runaway expression rather than relying solely on a client-side timer.
4. **Detect a wedged renderer.** If the execution context stops responding, report that explicitly (for example `EVALUATE_CONTEXT_UNRESPONSIVE`) rather than waiting silently.

## Why this matters disproportionately for agents

The caller is usually an autonomous agent with no human watching. A hung call does not merely fail the operation — it destroys the agent's entire turn, including all work completed beforehand. In this instance the code changes survived on disk but the agent's analysis, measurements and caveats were lost and had to be reconstructed from its JSONL transcript.

The general principle, shared with bug-003: **any tool an agent can call must fail fast and return something.** Silence is the one outcome an agent cannot recover from.

Note the caller's code was at fault here — spreading a large typed array is a genuine bug in the expression. That is precisely the point: user code will throw, and the tool's job is to report it rather than disappear.

## Environment

- cdp-tools MCP as configured for the project at `/Users/joshua/Documents/Code/music`
- macOS (darwin 25.3.0)
- Encountered 25-26 July 2026 while orchestrating concurrent autonomous agents
