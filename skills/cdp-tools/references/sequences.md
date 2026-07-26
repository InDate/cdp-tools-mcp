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

**Build one from calls you already made** - `create`

```
replay({ action: 'create', name: 'login-check', indices: [3, 4, 5] })
```

Every tool response footer shows its history index (`**Repeat:**` hint).
`replay({ action: 'history' })` lists them. This is usually faster than
recording when you've just done the steps yourself.

**Re-run single calls without making a sequence** - `repeat`

```
replay({ action: 'repeat', indices: [12] })
```

## Managing them

- `list` / `get` / `delete` - sequences in memory
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

Useful `run` parameters:

- `startUrl` - override the stored start URL for this run only (e.g. a
  freshly minted magic link)
- `baseUrl` - retarget every absolute URL at another origin, keeping paths and
  queries. Point a staging-recorded sequence at local
- `startFrom` - begin at step N (1-indexed)
- `stepTimeout` / `totalTimeout`
- `variables` - substitute recorded typed text (see below)
- `killChromeOnFinish` - tears down the **run-level** browser only. Browsers a
  step reached via its own `connectionReason` are deliberately left running,
  so a sequence can read from a long-lived instance you launched yourself
  without it being killed underneath you

Step through interactively with `step`, `finish`, `insert`, `status`, `cancel`.

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
