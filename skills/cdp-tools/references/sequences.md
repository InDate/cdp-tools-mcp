# Replay Sequences

A sequence is an ordered list of tool calls you can re-run. It's how cdp-tools
turns "I clicked around and hit the bug" into something repeatable - a
regression test, a repro attached to an issue, or a multi-step automation.

Everything below is the `replay` tool: `replay({ action: '...' })`.

## Getting a sequence

**Record what a human does** - `recordInteraction`

```
replay({ action: 'recordInteraction', connectionReason: 'signup-flow' })
```

Opens the page with a recording overlay and captures real mouse, keyboard and
navigation events. **This call blocks until the person finishes in the
browser** - there is no separate stop action. It returns the created sequence.
Pass `issueId` to name and link the recording to an issue (`bug-7-repro`).

Because it waits on a human, don't call it unattended - the same rule as
`issues({ action: 'resolve' })`.

Tune how events become commands with `simplifyEvents` (default true),
`includeHovers` (false), `preferCoordinates` (false - `x,y` clicks for
canvas/3D) and `preferSelectors` (false - selector clicks even for canvas;
wins if both preference flags are set). Add `outputFormat: 'events'` or
`'commands'` to get the raw captured events / converted commands as JSON
alongside the summary, or `'review'` for a readable walkthrough of the captured
events (coordinates, element and selector per interaction, plus navigations,
pastes and comments). All three are only available here - raw events are not
stored with the sequence.

**Build one from calls you already made** - `create`

```
replay({ action: 'create', name: 'login-check', indices: [3, 4, 5] })
```

Every tool response footer shows its history index (`**Repeat:**` hint).
`replay({ action: 'history' })` lists them. This is usually faster than
recording when you've just done the steps yourself.

**Re-run calls you already made, without building a sequence** - `repeat`

```
replay({ action: 'repeat', indices: [12] })                // one call
replay({ action: 'repeat', indices: [58, 59, 60, 61] })    // a whole stretch, in order
```

`indices` takes a list, so this replays a run of work in one call - and that is
usually the point. Whenever you are about to redo something you already did
(relaunch the browser, log in again, retype a form, get back to the screen
where the bug shows), repeat those indices instead of re-issuing the calls by
hand: it is faster, and retyped arguments drift from what actually ran.

Every tool response carries its own index in the footer, so the numbers are
already in front of you. `replay({ action: 'history' })` lists them when they
have scrolled away. If the stretch turns out to be worth keeping, hand the same
indices to `create`.

## Managing them

- `list` / `get` / `delete` - sequences in memory. `get` takes
  `outputFormat: 'commands' | 'playwright' | 'puppeteer'` to return the raw
  command JSON or generated test code instead of the detail view (`'events'`
  and `'review'` are recordInteraction-only - a stored sequence has no raw
  events, and `get` says so rather than ignoring them)
- `load` / `listSaved` / `deleteSaved` - sequences on disk
- `export` - write to a file as `sequence`, `playwright`, or `puppeteer`
- `global: true` on `export` saves to `~/.cdp-tools/sequences/` instead of the
  working directory

`load` and `create` reject a sequence naming a tool that doesn't exist, listing
the offending step, rather than failing halfway through a run after earlier
steps already changed state.

## Running

```
replay({ action: 'run', sequenceId: 'seq-login', connectionReason: 'my-app' })
```

**`run` does not block** (changed in 0.7): it returns a run id immediately and
executes in the background.

```
replay({ action: 'status', runId: 'run-3-...' })   // progress; full result once settled
replay({ action: 'cancel', runId: 'run-3-...' })   // stop it
```

`cancel` reaches the step that is in flight (including inside nested
`conditional` sequences), but what it can do there differs by tool - three
levels, and the difference matters:

- **Genuinely cancelled:** `wait` (all forms, mid-poll) and `request` with
  `destination: 'node'` (the socket is closed - the server sees it aborted).
- **Stops waiting, work continues:** `navigate` (deliberately no
  `Page.stopLoading` - a half-loaded page is worse than a loaded one),
  `inspect({ action: 'evaluateExpression' })`, `content({ action: 'parse' })`.
- **Checkpoint only:** `input` - an input event on the wire cannot be
  recalled, so cancelling stops events that had not gone out yet and undoes
  nothing already dispatched (a cancelled drag does still release the button).
  Same for `request` with `destination: 'browser'`, `screenshot`, and the
  non-waiting `content`/`inspect` actions.

`breakpoint({ action: 'await' })` is cancellable and now **fails** the step
(it used to report success). `dom`, `network` and everything else have no real
wait to interrupt, so they stop at the next step boundary. In every case, work
already dispatched to the browser may still take effect. Full table:
`docs/replay.md`.

Several runs can execute concurrently - even of the same sequence - and the
run id is what tells them apart. Settled runs and their results are kept in
memory for 30 minutes (max 50); after that, or after a server restart (which
kills in-flight runs), the id returns `REPLAY_RUN_NOT_FOUND`. Nested sequences
(`conditional` flows, `replay run` steps) are part of their parent run, never
separate runs. Pass `wait: true` to block until completion and get the full
result in one call (the pre-0.7 behaviour).

Useful `run` parameters:

- `startUrl` - override the stored start URL for this run only (e.g. a
  freshly minted magic link)
- `baseUrl` - retarget every absolute URL at another origin, keeping paths and
  queries. Point a staging-recorded sequence at local
- `startFrom` - begin at step N (1-indexed)
- `stepTimeout` / `totalTimeout` - each step is bounded by
  `min(stepTimeout, remaining totalTimeout)` (defaults 30s / 5min); a step that
  exceeds it fails the run at that step. `wait` steps are exempt from
  `stepTimeout` (they have their own `timeoutMs`) but still capped by
  `totalTimeout`
- `variables` - substitute recorded typed text (see below)
- `killChromeOnFinish` - tears down the **run-level** browser only. Browsers a
  step reached via its own `connectionReason` are deliberately left running,
  so a sequence can read from a long-lived instance you launched yourself
  without it being killed underneath you

Step through interactively with `step`, `finish`, `insert`, `status`, `cancel`
(`run` with `stepTo: N` pauses after step N; the run's status becomes `paused`
and you drive it from there). A bare `cancel` prefers the paused session;
use `runId` to address a specific background run.

## Two different "variables" - don't confuse them

**1. `variables` on `run` replaces recorded typed text.** Keyed by the recorded
input, for replaying a signup with a fresh email:

```
replay({ action: 'run', sequenceId: 'seq-signup',
         variables: { 'var_2_#email': 'new@example.com' } })
```

**2. `saveAs` captures a value mid-run for later steps.** Supported on
`request` and on `inspect({ action: 'evaluateExpression' })`. Later steps read
it with `{{var:name}}` or `{{var:name.path}}`:

```
request({ url: '...', saveAs: 'login' })          // stores the whole response
inspect({ action: 'evaluateExpression',
          expression: 'document.querySelector("#pair").href',
          saveAs: 'pairingUrl' })                  // stores the value itself
navigate({ action: 'goto', url: '{{var:pairingUrl}}' })
assert({ left: '{{var:login.body.token}}', operator: 'exists' })
```

Note the asymmetry: `request` stores the response object (so you index into
`.body`), `inspect` stores the evaluated value directly. A `saveAs` that can't
be honoured fails the step rather than silently capturing nothing.

Values that only render as a description (`[HTMLDivElement]`, `Array(3)`) come
back as strings - capture a specific field rather than a whole DOM object.

## Waiting for async work

Recording by hand hides races: driving tools interactively puts seconds
between calls, so async work always looks settled. Replayed back-to-back, a
step after a navigation or an async kick-off reads state that isn't there
yet. `wait` is the sequence step for that:

```
{ tool: 'wait', params: { selector: 'button:has-text("Join")' } }   // appears
{ tool: 'wait', params: { selectorGone: '.spinner' } }              // disappears
{ tool: 'wait', params: { expression: 'window.__probe !== "PENDING"' } }
{ tool: 'wait', params: { ms: 500 } }                               // last resort
```

Exactly one form per step. Condition forms poll a **synchronous** check from
the MCP side (default: every 100ms, up to `timeoutMs` 15000), so they survive
a navigation mid-wait and don't depend on in-page timers or promises. On
timeout the step fails and stops the run - a `wait` never hangs. For async
in-page work, kick it off in one step, store the result in a global, then
`wait({ expression: 'window.__result !== undefined' })` and read it with
`inspect` + `saveAs`.

Historical note: sequences in the wild use a marker-div + hover-on-
`:has-text()` idiom (an `input({ action: 'hover' })` on an element that only
exists once async work settles). That was never stylistic - hover's short
implicit element-wait was the *only* step that waited at all before `wait`
existed. Don't copy the pattern into new sequences; use `wait` and `assert`.

## Multi-device / multi-browser sequences

Any step may carry its own `connectionReason`, and it is honoured for
validation and pause handling, not just dispatch. That's what makes
"device A scans, device B confirms" sequences work in one run:

```
{ tool: 'input',   params: { action: 'click', selector: '#pair',
                             connectionReason: 'device-a' } }
{ tool: 'inspect', params: { action: 'evaluateExpression',
                             expression: '...', saveAs: 'code',
                             connectionReason: 'device-a' } }
{ tool: 'navigate', params: { action: 'goto', url: '{{var:code}}',
                              connectionReason: 'device-b' } }
```

Steps without an explicit `connectionReason` use the run-level one.

## Conditional steps

`conditional` is a virtual step tool - it runs a nested sequence when a
condition holds. It's handled inside the executor and never appears in the
tool list, which is why it's exempt from tool-name validation. Nested
sequences share the parent run's captured variables.

## Verifying a fix

`issues({ action: 'workOn', id: N })` replays an issue's linked sequence so you
can see the bug reproduce, fix it, then replay again. Closing the issue is
`resolve`, which is human-gated - an agent should record findings with
`comment` and leave the closing to a person.
