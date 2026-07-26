# Command Replay

Record and replay command sequences for testing, automation, and debugging workflows.

> **Tip:** Use the `replay-agent` (`.claude/agents/replay-agent.md`) to build sequences through investigation - it records your tool calls automatically.
>
> For a condensed, agent-facing version of this material see
> `skills/cdp-tools/references/sequences.md`. This document is the fuller
> reference with worked examples.

## Actions

Every capability below is the one `replay` tool, dispatched on `action`:

| Group | Actions |
|---|---|
| History | `history`, `repeat`, `runFromLog` |
| Authoring | `create`, `recordInteraction`, `insert` |
| Managing | `list`, `get`, `delete`, `export`, `load`, `listSaved`, `deleteSaved` |
| Running | `run`, `step`, `finish`, `status`, `cancel` |

There is no `stopInteraction` and no `save` action - see
[Recording Interactions](#recording-interactions) and
[Saving and Loading](#saving-and-loading).

## Recording Interactions

The easiest way to create a sequence is to record your interactions directly in
the browser.

```javascript
// Launch Chrome with a meaningful name
launchChrome({ reference: "my-signup-test" })

// Start recording - THIS CALL BLOCKS until you finish in the browser
replay({ action: 'recordInteraction', connectionReason: 'my-signup-test' })
```

**`recordInteraction` blocks until the person finishes in the browser overlay.**
There is no separate stop call. The tool call returns only once you click ✓
(complete) or ✕ (cancel) in the overlay, and its response *is* the created
sequence summary. Because it waits on a human, don't call it unattended.

If no connection exists for `connectionReason`, Chrome is auto-launched - but
only if you also pass `startUrl` (or an `issueId` whose issue carries one). If a
connection already exists and you pass `startUrl`, the page navigates there
first.

### The Recording Overlay

A visual overlay appears showing:
- Recording status (`REC` / `PAUSED`)
- Event count and duration
- Coordinates and element info
- Buttons: 💬 Comment | ⏸ Pause | ↺ Reset | ✓ Complete | ✕ Cancel

Pass `showOverlay: false` to suppress it.

### Add Comments

During recording, add comments to document expected behavior:
- Click the 💬 button in the overlay
- Or press **Ctrl/Cmd+Shift+C** (plain comment), **Ctrl/Cmd+Shift+B** (bug),
  **Ctrl/Cmd+Shift+F** (feature)

Comments are attached to the previous action and appear in exported tests.

**Bug and feature comments create issues.** Each `bug`/`feature` comment becomes
an entry in the issue tracker with its own copy of the sequence saved as
`<type>-<id>-repro`. When a recording contains any such comment, no plain
in-memory sequence is created - the issue sequences are the output.

### Naming

The sequence is named, in order of preference:
1. the `name` you passed,
2. `<issueType>-<issueId>-repro` when you passed `issueId`,
3. the `connectionReason`.

If a sequence with that name already exists you get a conflict response. Re-run
with a different `name`, or with `overwrite: true`.

### Recording Options

The conversion from raw input events to sequence commands is tunable. All four
flags default to today's behaviour, so omitting them changes nothing:

| Option | Default | Effect |
|---|---|---|
| `simplifyEvents` | `true` | Collapse noisy raw events (mousemove runs, key repeats) before conversion. `false` keeps them all. |
| `includeHovers` | `false` | Emit `input({ action: 'mousemove' })` steps for hovers. Needs `simplifyEvents: false` to keep more than the settled positions. |
| `preferCoordinates` | `false` | Emit `x,y` clicks even where a selector was captured. Use for canvas/3D/drag-heavy UIs. |
| `preferSelectors` | `false` | Emit selector clicks wherever a selector exists - *including* canvas elements, which otherwise fall back to coordinates. |

If both `preferCoordinates` and `preferSelectors` are `true`, **`preferSelectors`
wins** - the more portable of the two is chosen.

```javascript
replay({
  action: 'recordInteraction',
  connectionReason: 'canvas-bug',
  preferCoordinates: true,   // a WebGL canvas has no useful selectors
  includeHovers: true,       // the bug is a hover artefact
  simplifyEvents: false
})
```

`recordInteraction` also accepts `outputFormat`, which appends a dump to the
usual recording summary:

- `events` - the raw captured input events as JSON (this is the only place they
  are ever available; they are not stored with the sequence)
- `commands` - the converted command list as JSON
- `review` - a human-readable walkthrough of the captured events: one numbered
  entry per interaction with its coordinates, the element and selector found for
  it, plus navigations, pastes and the comments the person left while recording
- `playwright` / `puppeteer` - generated test code for the fresh recording

Use `outputFormat: 'events'` when a recording produced surprising commands and
you need to see what the recorder actually captured; `review` is the same
information in a form you can read, and is the better choice when you want to
decide whether a step should use a selector or coordinates.

### Recording Against an Issue

```javascript
replay({ action: 'recordInteraction', connectionReason: 'bug-7', issueId: 7 })
```

The issue's `type`, `title` and `startUrl` are used automatically, a fullscreen
issue overlay is shown, and the finished sequence is saved into the issues
folder and linked to issue #7.

## Exporting Tests

Export sequences as Playwright or Puppeteer tests:

```javascript
// Export as Playwright test
replay({ action: 'export', name: 'my-signup-test', format: 'playwright' })
// Creates: tests/e2e/my-signup-test.spec.ts
// Also saves: .cdp-tools/sequences/my-signup-test.json

// Export as Puppeteer test
replay({ action: 'export', name: 'my-signup-test', format: 'puppeteer' })
// Creates: tests/puppeteer/my-signup-test.test.js

// Export sequence JSON only (default format)
replay({ action: 'export', name: 'my-signup-test', format: 'sequence' })
// Creates: .cdp-tools/sequences/my-signup-test.json
```

`export` always writes the sequence JSON first, whatever the format. If a target
file already exists you get a conflict response; re-run with `overwrite: true`.

Only `navigate` and `input` steps are translated into Playwright/Puppeteer code
- debugging steps (`breakpoint`, `inspect`, `request`, ...) have no equivalent
and are dropped from the generated test.

### Configure Export Paths

In `.cdp-tools/config.json`:

```json
{
  "replay": {
    "playwrightExportPath": "./tests/e2e",
    "puppeteerExportPath": "./tests/puppeteer"
  }
}
```

### Preview Before Export

```javascript
// Preview as Playwright code
replay({ action: 'get', name: 'my-signup-test', outputFormat: 'playwright' })

// Preview as Puppeteer code
replay({ action: 'get', name: 'my-signup-test', outputFormat: 'puppeteer' })

// The raw command list as JSON (what actually gets executed)
replay({ action: 'get', name: 'my-signup-test', outputFormat: 'commands' })
```

`outputFormat` on `get` accepts `commands`, `playwright` and `puppeteer`.
`events` and `review` are not valid here and each returns an error explaining
why: a stored sequence holds converted *commands*, never the raw input events,
and both of those formats render events. The raw events exist only during a
recording - see [Recording Options](#recording-options) for
`outputFormat: 'events'` and `outputFormat: 'review'` on `recordInteraction`.

## Visual Replay Cursor

When replaying sequences, a visual cursor shows where clicks happen:

- **Animated cursor** moves to the click position before clicking
- **Green ripple** on the click
- **Key press toast** shows keyboard input

The cursor is only driven for *coordinate* clicks (`input({ action: 'click', x,
y })`) and for `input({ action: 'press' })`. Selector-based clicks execute
without a cursor effect.

Configure in `.cdp-tools/config.json`:

```json
{
  "replay": {
    "showCursor": true
  }
}
```

## Creating Sequences from History

### From Command History

```javascript
// View command history
replay({ action: 'history', limit: 20 })

// Create sequence from history indices
replay({
  action: 'create',
  name: 'login-flow',
  indices: [1, 2, 3, 4, 5]
})
```

Every tool response footer shows its own history index, so you usually don't
need to call `history` first.

### With Metadata

Add description, expected outcome and a start URL for better documentation:

```javascript
replay({
  action: 'create',
  name: 'login-flow',
  description: 'Logs into the application with test credentials',
  expectedOutcome: 'User should be redirected to dashboard with welcome message',
  startUrl: 'http://localhost:3000/login',
  indices: [1, 2, 3, 4, 5]
})
```

These fields are saved to disk and displayed when listing sequences.

### Re-running History Directly

```javascript
// Execute commands straight from history without making a sequence
replay({ action: 'repeat', indices: [12, 13] })

// Execute lines from .cdp-tools/history.log (1-indexed, line 1 = most recent)
replay({ action: 'runFromLog', lines: [3, 4, 5] })
```

Both stop at the first failing command. Both infer `connectionReason` from a
`launchChrome`/`connectDebugger` command in the selection if you don't pass one,
and error out if the commands need a connection and none can be determined.

## Tool-Name Validation

`create` and `load` reject a sequence whose steps name a tool that doesn't
exist, **before anything runs**:

```
Error: Sequence "login-flow" references 1 unknown tool name
The "load" action was rejected before any step ran, so no browser state was changed.

- Step 4: `navigatee` is not a known tool - did you mean `navigate`?

**Fix:** correct the `tool` field on the listed step(s).
```

Notes:
- Only the tool *name* is checked. Params are deliberately not validated against
  the tools' schemas, because a param may legitimately hold a `{{var:...}}` or
  `{{timestamp}}` token at rest that only resolves to its real type at run time.
- `conditional` is exempt - it is a virtual step tool the executor handles
  itself and it is never a registered tool (see [Conditional Steps](#conditional-steps)).
- A rejected `create` does not clobber an existing same-named sequence; a
  rejected `load` is dropped from memory so it can't be run by id.

## Managing Sequences

```javascript
// List all in-memory sequences
replay({ action: 'list' })

// View sequence details (by sequenceId or name)
replay({ action: 'get', sequenceId: 'seq-1234567890' })
replay({ action: 'get', name: 'login-flow' })  // memory first, then disk (fuzzy name match)

// Delete a sequence from memory
replay({ action: 'delete', sequenceId: 'seq-1234567890' })
```

## Saving and Loading

```javascript
// Export sequence to disk (working directory)
replay({ action: 'export', sequenceId: 'seq-1234567890', format: 'sequence' })
// Saves to: .cdp-tools/sequences/<name>.json

// Export to global location (accessible from any directory)
replay({ action: 'export', sequenceId: 'seq-1234567890', format: 'sequence', global: true })
// Saves to: ~/.cdp-tools/sequences/<name>.json

// List saved sequences on disk (add showAll: true to include completed issues)
replay({ action: 'listSaved' })

// Load sequence from disk
replay({ action: 'load', filename: 'login-flow.json' })

// Load into history (for editing)
replay({ action: 'load', filename: 'login-flow.json', intoHistory: true })

// Delete saved file
replay({ action: 'deleteSaved', filename: 'login-flow.json' })
```

`run` and `get` load by `name` from disk on their own, so `load` is only needed
when you want the sequence in memory (or in history) first.

## Running Sequences

### Basic Run

```javascript
replay({
  action: 'run',
  sequenceId: 'seq-1234567890',
  connectionReason: 'test-session'
})
```

Or by name, which also finds it on disk:

```javascript
replay({ action: 'run', name: 'login-flow', connectionReason: 'test-session' })
```

### Auto-Launch Chrome

If the sequence starts with `launchChrome`, no `connectionReason` is needed -
the launch step's `reference` becomes the run's connection.

```javascript
replay({ action: 'run', sequenceId: 'seq-my-flow' })
```

Otherwise, if the sequence needs a browser and no connection is active, Chrome
is launched as a **fresh instance** using `connectionReason` (or a reference
derived from the sequence name when you didn't pass one).

### Retargeting a Run

```javascript
// Point a staging-recorded sequence at local
replay({ action: 'run', name: 'checkout', baseUrl: 'http://localhost:3000' })

// Enter through a freshly minted link, once
replay({ action: 'run', name: 'magic-link-login', startUrl: 'https://app.example.com/m/abc123' })
```

- **`baseUrl`** rewrites the origin of *every absolute* `http(s)` URL in the
  sequence - the stored `startUrl` and any string param in any step (a
  `navigate goto` url, a `request` url, ...) - keeping path, query and hash.
  Relative URLs are untouched. The stored sequence is never mutated.
- **`startUrl`** replaces the sequence's start URL wholesale for this run,
  applied after any rebasing.
- Neither is preserved across a mid-run pause and `step`/`finish` resume, which
  re-reads the stored sequence.

### Timeout Configuration

```javascript
replay({
  action: 'run',
  sequenceId: 'seq-slow-flow',
  connectionReason: 'test-session',
  stepTimeout: 60000,    // per step (default: 30000)
  totalTimeout: 600000   // whole run (default: 300000)
})
```

### Start From a Specific Step

```javascript
replay({
  action: 'run',
  name: 'login-flow',
  connectionReason: 'test-session',
  startFrom: 5  // Skip steps 1-4, start at step 5 (1-indexed)
})
```

`startFrom` beyond the sequence length is rejected.

### Pause, Step, Finish

```javascript
replay({ action: 'run', name: 'login-flow', stepTo: 3 })  // run steps 1-3, then pause
replay({ action: 'status' })                              // where am I?
replay({ action: 'step', stepCount: 2 })                  // run the next 2 steps
replay({ action: 'finish' })                              // run the rest
replay({ action: 'cancel' })                              // drop the paused session
```

While paused you can run tools by hand and then splice them into the sequence:

```javascript
replay({ action: 'history' })                    // required before inserting by index
replay({ action: 'insert' })                     // show what's insertable
replay({ action: 'insert', insertIndices: [42, 43], insertAfterStep: 3 })
```

By default `insert` creates a new sequence named `<name>-modified` (override
with `newName`); pass `overwrite: true` to edit the sequence in place.

### Closing Chrome Afterwards

```javascript
replay({ action: 'run', name: 'smoke-test', connectionReason: 'ci-run',
         killChromeOnFinish: true })
```

`killChromeOnFinish` kills **only** the Chrome behind this run's own
(run-level) connection, and only after the run finishes - it is skipped on
pause, breakpoint, click-validation failure or abort.

Browsers that a *step* reached via its own `connectionReason` are deliberately
left running. This narrowness is intentional: nothing tracks which connections
the run itself caused to be launched, a per-step connection is usually a
long-lived instance you started by hand, and a `launchChrome` step silently
reuses an existing connection with the same reference - so its presence proves
nothing about ownership. The executor would rather under-kill: a leaked browser
is visible and closable, a killed one takes state you cannot get back.

### Preview Sequence

```javascript
replay({ action: 'get', name: 'login-flow' })
// Shows: commands, substitutable variables, metadata, and run instructions
```

## Variables: Two Unrelated Mechanisms

`replay` has two features that both get called "variables". They share nothing
but the word.

| | `variables` on `run` | `saveAs` + `{{var:...}}` |
|---|---|---|
| What it does | Replaces **recorded typed text** before the run | Captures a **value produced mid-run** for later steps |
| Set where | A parameter of `replay({ action: 'run' })` | A param on an individual sequence step |
| Read where | Only by `input({ action: 'type' })` steps | Any step param, via `{{var:name}}` |
| Naming | Auto-generated `var_<i>_<selector>` keys | Names you choose |

### 1. `variables` - substituting recorded typed text

Every recorded `input({ action: 'type' })` step gets an auto-generated key of
the form `var_<0-based step index>_<selector, non-alphanumerics replaced by _>`
(or `var_<i>_text` when the step has no selector).

```javascript
// Original recording had: input({ action: 'type', selector: '#email', text: 'original@email.com' })
replay({
  action: 'run',
  sequenceId: 'seq-login-flow',
  connectionReason: 'test-session',
  variables: {
    'var_2_#email': 'new@email.com',
    'var_3_#password': 'newpassword'
  }
})
```

**If the sequence contains any typed text and you omit `variables` entirely,
`run` does not execute** - it returns a prompt listing the substitutable keys
and their recorded values. Pass `variables: {}` to accept the recorded values
as-is, or supply the keys you want to change.

### 2. `saveAs` and `{{var:name.path}}` - capturing values mid-run

A step can capture its own result into the run's variable store with `saveAs`.
Later steps read it back with `{{var:name}}` / `{{var:name.path}}` in any
param.

Supported on exactly two tools today:

| Step | What gets stored |
|---|---|
| `request` | the **whole response object** - address into it: `{{var:login.body.token}}` |
| `inspect({ action: 'evaluateExpression' })` | the **evaluated value itself** - use it directly: `{{var:pairingUrl}}` |

```json
{ "tool": "request", "params": {
    "url": "https://api.example.com/login", "method": "POST", "saveAs": "login" } }

{ "tool": "inspect", "params": {
    "action": "evaluateExpression",
    "expression": "document.querySelector('#pair').href",
    "saveAs": "pairingUrl" } }

{ "tool": "navigate", "params": { "action": "goto", "url": "{{var:pairingUrl}}" } }

{ "tool": "assert", "params": {
    "left": "{{var:login.body.token}}", "operator": "exists" } }
```

Behaviour worth knowing:

- A `saveAs` that cannot be honoured (unsupported tool, or a call that produced
  nothing capturable) **fails the step**. It is never a silent no-op, because the
  failure would otherwise surface far away as a confusing "no variable named ..."
  message.
- Async expressions work: a Promise returned by `evaluateExpression` is awaited
  by default, so an async IIFE (IndexedDB read, `crypto.subtle`, `fetch`)
  captures its **settled value**, not the Promise object. A rejection fails the
  step with the expression's own error.
- JSON-serializable results are captured **by value** (exact - a string `"42"`
  stays a string). Values that only render as a description (`[HTMLDivElement]`,
  `Array(3)`) come back as strings - capture a specific field, not a whole DOM
  object.
- The store is shared by reference across the whole run, including nested
  `conditional` sequences and steps running on other connections, and it
  survives a mid-run pause into `step`/`finish`.

### Interpolation Tokens

`{{var:...}}` and `{{timestamp}}` are resolved in a step's params immediately
before it executes.

- `{{timestamp}}` - milliseconds, computed **once per run** and reused by every
  step (including later `step`/`finish` calls), so all steps agree on it.
- `{{timestamp+3600000}}` / `{{timestamp-1000}}` - the same run timestamp with a
  millisecond offset, for expiry-style fields.
- `{{var:a.b.c}}` - dot-separated path. For a key containing a literal dot, use
  bracket notation for that segment: `{{var:a.b['exec.t1.s2'].c}}`.
- **Whole-string tokens keep their type.** `"right": "{{var:r.body.count}}"`
  resolves to the number `3`; `"name": "kit{{timestamp}}"` resolves to the
  string `"kit1699999999999"`.
- An unresolvable token fails the step with a message telling you which
  `saveAs` to add.

## Per-Step Connections (Multi-Device Sequences)

Any step may carry its own `connectionReason`. Steps that don't get the
run-level connection injected (for the tools that accept one).

```json
{ "tool": "input",    "params": { "action": "click", "selector": "#pair",
                                  "connectionReason": "device-a" } }
{ "tool": "inspect",  "params": { "action": "evaluateExpression",
                                  "expression": "document.querySelector('#code').textContent",
                                  "saveAs": "code", "connectionReason": "device-a" } }
{ "tool": "navigate", "params": { "action": "goto", "url": "{{var:code}}",
                                  "connectionReason": "device-b" } }
```

A per-step connection is honoured for **everything wrapped around the step**,
not just for dispatching it: pre/post-click state capture, click validation,
navigation validation, typed-text validation, breakpoint/pause detection,
failure diagnostics, and the wait for the *next* step's element (which follows
the next step's connection). That is what makes "device A scans, device B
confirms" work in a single run.

Details:

- Connection injection applies to `navigate`, `content`, `input`, `console`,
  `network`, `dom`, `screenshot`, `storage`, `inspect`, `execution`,
  `breakpoint`, `getSourceCode`, `detectModals`, `dismissModal`.
- `request` is handled separately: it only receives a connection when the step
  sets `destination: 'browser'`, so Node-targeted sequences never drag a Chrome
  launch in.
- Only the browser-only tools (the first group above) make a sequence
  "need a connection" and trigger Chrome auto-launch. A Node-only debugging
  sequence won't spuriously launch Chrome.
- `connectionReason` is stripped from commands recorded into history, so
  history-built sequences are portable; per-step connections are something you
  add deliberately when hand-authoring or editing a sequence.

## Conditional Steps

`conditional` is a virtual step tool: it is handled inside the executor, never
appears in the tool list, and is exempt from tool-name validation.

```json
{ "tool": "conditional", "params": {
    "if": "{{selector:.cookie-banner}}",
    "then": "dismiss-cookie-banner" } }
```

`then` is the name of another sequence, loaded and run inline when the condition
holds. Any `launchChrome` steps in it are filtered out (a connection already
exists), and it shares the parent run's captured variables.

Supported conditions:

| Condition | True when |
|---|---|
| `{{selector:CSS}}` / `{{!selector:CSS}}` | element exists / doesn't |
| `{{url:contains:STRING}}` | current URL contains the string |
| `{{url:matches:REGEX}}` | current URL matches the regex |
| `{{url:EXACT}}` | current URL equals the value |
| `{{cookie:NAME}}` / `{{!cookie:NAME}}` | cookie exists / doesn't |
| `{{localStorage:KEY}}` / `{{!localStorage:KEY}}` | key exists / doesn't |

A condition that is legitimately *not met* skips the nested sequence and the
step counts as a success. A condition that cannot be *evaluated* (bad format,
unknown type, invalid or over-long regex, tool error) fails the run.

Nesting is capped by `replay.maxConditionalDepth` (default 10) and regexes by
`replay.maxRegexLength` (default 500); both are `.cdp-tools/config.json`
settings. Oscillating chains (A→B→A) are allowed up to the depth limit.

## Debug-Aware Replay

Replay handles debugging sequences specially.

### Fresh callFrameId Replacement

When replaying `inspect({ action: 'getVariables' })` with a recorded
`callFrameId`, replay fetches the current call stack on that step's connection
and swaps in a fresh ID.

### Auto-Resume

If the debugger is already paused when a run starts (or when checking an
existing connection), replay resumes it first, so a leftover pause from a
previous run can't stall the sequence.

### Expected vs Unexpected Breakpoints

Replay tracks breakpoints that the sequence itself sets (`breakpoint({ action:
'set' })`), including ±1 line to absorb CDP's 0-based/1-based resolution. After
each step it checks whether execution is paused:

- paused at a breakpoint this sequence set → **keep going**;
- paused anywhere else → **stop and report the breakpoint hit**, with the pause
  location and the connection to inspect it on.

### Debug State Output

After a run that completed with no failures, if breakpoints are active or
execution is paused, replay appends the current debug state:

```
## Debug State

⏸️ **Execution paused** at http://localhost:3101/client.js:6

**Next steps:**
- Inspect call stack: `inspect({ action: 'getCallStack', connectionReason: '...' })`
- Get variables: `inspect({ action: 'getVariables', connectionReason: '...', callFrameId: '<from call stack>' })`
- Resume execution: `execution({ action: 'resume', connectionReason: '...' })`
- Step over: `execution({ action: 'stepOver', connectionReason: '...' })`

🔴 **1 active breakpoint**
- List breakpoints: `breakpoint({ action: 'list', connectionReason: '...' })`
```

## Step Robustness

Beyond click validation, each step gets some automatic help:

- **Retries:** `input` `click` / `type` / `hover` retry up to 5 times, 500ms
  apart, when the failure looks like "element not found" - enough for a
  component that hasn't mounted yet.
- **Element pre-wait:** after a `navigate` step or a click, if the next step is
  an `input` with a selector, replay waits for that selector (5 tries, 500ms
  apart) on the *next step's* connection.
- **Navigation validation:** after every `navigate` step, replay checks the page
  didn't land on `about:blank`, a `chrome-error://` page, an `ERR_*`, or a
  "site can't be reached" title.
- **Port check:** before navigating to a `localhost` URL (including the
  sequence's `startUrl`), the port is checked and the run fails fast with a
  clear message rather than loading an error page.
- **Typed-text validation:** after `input({ action: 'type', selector })`, the
  field's value (or `innerText` for contenteditable) is compared against what
  was typed - exact match, or "ends with" when `append: true`.
- **Recorded delays:** delays captured during interaction recording are replayed
  (capped by `replay.maxDelayMs`, default 1000ms).

These are best-effort niceties with short, fixed budgets. When a step
genuinely depends on async work settling - a page load after `location.href`,
a spinner clearing, an async probe writing a global - add an explicit `wait`
step instead of relying on them.

## Explicit Waits (`wait` steps)

`wait` is a first-class sequence step for "the previous step kicked off async
work". Exactly one of four mutually exclusive forms:

```javascript
{ tool: 'wait', params: { selector: 'button:has-text("Join")' } }  // element appears
{ tool: 'wait', params: { selectorGone: '.spinner' } }             // element disappears
{ tool: 'wait', params: { expression: 'window.__probe !== "PENDING"' } }
{ tool: 'wait', params: { ms: 500 } }                              // fixed sleep, last resort
```

- The condition forms are polled **from the MCP side** as a synchronous check
  (default `pollIntervalMs` 100, `timeoutMs` 15000). Because nothing waits
  inside the page, a wait survives a navigation that happens mid-wait (each
  poll simply runs in whatever document exists at that moment) and never
  depends on in-page timers or promises resolving.
- `expression` must be synchronous - don't `await` in it. Kick async work off
  in a prior step, have it write a global, and wait on the global.
- On timeout the step returns an error (`WAIT_TIMEOUT`, including the last
  evaluation error if the predicate was throwing), which stops the sequence
  like any other failed step. A `wait` never hangs a run.
- The run-level `connectionReason` is injected like any other step, and a
  per-step `connectionReason` is honoured (multi-device sequences).
- `wait({ ms })` needs no browser at all and never triggers a Chrome
  auto-launch; `wait({ expression })` also works against a Node.js target.

## Click Validation

Click steps validate their effects. When validation fails, the sequence pauses
for inspection rather than failing outright.

### What Gets Validated

- **Console errors**: new errors after the click (default: enabled, fail mode `error`)
- **Navigation**: if the click caused navigation, that it succeeded (default: enabled)
- **DOM mutations**: whether the click changed anything (default: disabled)
- **Network requests**: failed POST requests (default: disabled)

New console warnings and logs are recorded as information only.

### Pause on Failure

When validation fails the sequence pauses **on the failed step** - the active
sequence's cursor is rewound so the next `step` re-runs it. You can:

- inspect the error state with `console`, `network`, `dom`, `screenshot`, ...
- retry the failed step: `replay({ action: 'step', stepCount: 1 })`
- run the rest: `replay({ action: 'finish' })`
- abandon it: `replay({ action: 'cancel' })`

There is no "skip this step" action - `step` always re-runs the step it is
parked on.

### Configuration

Configure in `.cdp-tools/config.json` (values shown are the defaults):

```json
{
  "clickValidation": {
    "enabled": true,
    "validateNavigation": true,
    "requireDomChanges": false,
    "domChangesFailMode": "warn",
    "failOnConsoleErrors": true,
    "consoleErrorsFailMode": "error",
    "validateNetworkPayload": false,
    "networkFailMode": "warn",
    "postClickDelayMs": 100
  }
}
```

**Fail modes:**
- `error`: pauses the sequence for inspection
- `warn`: logs a warning and continues

## Use Cases

### Regression Testing

```javascript
// Record interactions directly - this call blocks until you click ✓ in the browser
launchChrome({ reference: "checkout-test" })
replay({ action: 'recordInteraction', connectionReason: 'checkout-test' })

// Export as Playwright test
replay({ action: 'export', name: 'checkout-test', format: 'playwright' })

// Run anytime to verify
replay({ action: 'run', name: 'checkout-test', connectionReason: 'test-run' })
```

### Debugging Workflows

```javascript
// Create a debug sequence from what you just did
replay({
  action: 'create',
  name: 'debug-auth-bug',
  description: 'Sets breakpoint on auth handler and triggers login',
  expectedOutcome: 'Debugger pauses at auth.js:42 showing user object',
  indices: [0, 1, 2, 3, 4, 5]
})

// Run to debug - debug state is shown automatically after the run
replay({ action: 'run', name: 'debug-auth-bug' })
```

### Verifying the Same Flow on Two Deployments

```javascript
replay({ action: 'run', name: 'checkout', baseUrl: 'http://localhost:3000' })
replay({ action: 'run', name: 'checkout', baseUrl: 'https://staging.example.com' })
```

### Cross-Device Handoff

Hand-author steps with per-step `connectionReason` and capture the handoff value
with `saveAs` - see [Per-Step Connections](#per-step-connections-multi-device-sequences).

### Automation

```javascript
replay({
  action: 'create',
  name: 'daily-smoke-test',
  description: 'Navigates key pages and checks for console errors',
  expectedOutcome: 'All pages load without errors',
  indices: [0, 1, 2, 3, 4, 5, 6, 7]
})

replay({ action: 'run', name: 'daily-smoke-test', killChromeOnFinish: true })
```

## Notes

- **Recording:** only tool calls are recorded, not responses.
- **Replay:** steps execute sequentially, and the run stops at the first failing
  step.
- **Persistence:** in-memory sequences are cleared on restart; use
  `export`/`load` for disk persistence. `run` and `get` load from disk by name
  automatically.
- **Connection stripping:** `connectionReason` is removed from commands as they
  are recorded into history, for portability.
- **Validation timing:** tool *names* are validated at `create`/`load` time;
  `run` does not re-validate, so a sequence edited on disk by hand is best
  round-tripped through `load` before running.
