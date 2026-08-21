# devharness

[![npm version](https://img.shields.io/npm/v/devharness.svg)](https://www.npmjs.com/package/devharness)
[![license](https://img.shields.io/npm/l/devharness.svg)](https://github.com/InDate/devharness/blob/main/LICENSE)

MCP server. Your agent runs the app, sees what happened, and redoes none of it by
hand.

```bash
npx devharness@latest
```

> Was `cdp-tools-mcp`. That name described the transport. CDP is now one of three
> things this does. [Migrating](#migrating).

## Why

Three things burn a debugging session, and only the first is about seeing.

**You are the eyes.** You start the app, click the thing, paste the stack trace
back into chat, reload and report whether it worked.

**Everything gets re-driven by hand.** Relaunch the browser, log in again, refill
the form, click back to the screen where the bug lives — every iteration. Slow,
and the retyped arguments drift from what actually ran.

**One failure stalls the whole session.** A dead dev server, a missing parameter,
a wedged tool: the agent stops and waits for you.

devharness closes all three. Real execution instead of guesses. Every call it has
already made is replayable by index. Failures have recovery paths the agent takes
itself.

## What it does

24 tool modules. 802 tests across 57 files, ~7s.

**See** — pause real execution and read the real frame: breakpoints (line,
conditional, logpoint, DOM mutation, event, XHR), call stack and scope, source
maps so TypeScript breakpoints hit TypeScript lines. Chrome and Node.js
(`node --inspect`), both at once. Console, network, storage, DOM. `content verify`
reports dead buttons, dead links, small touch targets, and overflow clipping from
CDP facts, not heuristics.

**Repeat** — every tool response carries its own history index:

```
**Repeat:** replay({ action: 'repeat', indices: [58] })
```

`indices` takes a list, so four steps re-run in one call. Whatever the agent
already did, it redoes by reference rather than by retyping. Worth keeping?
`replay({ action: 'create', ... })` promotes it to a named sequence, exportable as
a Playwright or Puppeteer test.

**Recover** — a call that fails validation comes back with a `continuationToken`
and the list of what was missing; the retry sends only the missing field. A
validated call blocked by a guard is already recorded, so acknowledging the block
and replaying resumes the exact call. If the server itself wedges,
`config({ action: 'restart' })` respawns it and replays the MCP handshake, so the
host session never reconnects.

**Prove** — dev servers run under management (npm, flask, docker, compose) with
port monitoring. Issues bind a bug to its reproduction: `workOn` navigates back to
the failing state, `resolve` replays the sequence against the fix.

## Design decisions

- **A dead server blocks tools rather than warning.** An agent clicking away at a
  dead server produces a long, confident, entirely fictional debugging session.
  Configurable: `inform`, `error`, `block`.
- **Closing an issue needs a human click.** `resolve` waits on a browser overlay
  no agent can dismiss. Recording findings is automated; declaring something
  actually fixed stays a human judgement.
- **Repeat is on every response, not just failures.** Recovery and ordinary
  re-running are the same mechanism, so there's nothing extra to reach for when
  the session gets long.
- **`getVariables` degrades, never errors.** full → reduced depth → names →
  counts. A truncated answer that says it truncated beats a tool error.
- **Connections are named.** Every tool takes `connectionReason`, so nested agents
  each drive their own tab in one Chrome without fighting over "the current page".
- **Text beats screenshots.** `extractText` costs a fraction of an image and
  answers most page questions. Screenshot when the question is genuinely visual.

## Setup

**Claude Code:**
```bash
claude mcp add devharness -- npx devharness@latest
```

**Claude Desktop:**
```json
{
  "mcpServers": {
    "devharness": {
      "command": "npx",
      "args": ["-y", "devharness@latest"]
    }
  }
}
```

**Other clients** — `npx devharness@latest` over stdio.

**As a Claude Code plugin** — this registers the server for you:
```
/plugin marketplace add InDate/indate-tools
/plugin install devharness@indate-tools
```
The plugin pins an exact server version rather than tracking `@latest`, so what
you installed is what runs until you update it.

### Skill

Bundled [Agent Skill](https://agentskills.io) at `plugin/skills/devharness/`. Same
guidance as `docs/instructions.md`, split for progressive disclosure: name and
description at session start, full catalogue only when debugging starts.

```bash
mkdir -p .claude/skills
ln -s ../../node_modules/devharness/plugin/skills/devharness .claude/skills/devharness
```

Installing as a Claude Code plugin does this for you.

## Example

Node service:

```
1. node --inspect=9229 app.js
2. connectDebugger({ reference: "api", port: 9229 })
3. breakpoint({ action: 'set', connectionReason: "api", file: "user.ts", line: 42 })
4. Trigger the request.
5. inspect({ action: 'getVariables', connectionReason: "api" })
   → real frame: what userId and userRole actually were
```

Browser fix:

```
1. launchChrome({ reference: "app" })   # launches and connects
2. Record the five clicks that reproduce it.
3. Fix the code.
4. Replay → pass or fail, against the real app
```

[docs/GUIDE.md](./docs/GUIDE.md) for depth, [docs/instructions.md](./docs/instructions.md)
for the tool reference. [examples/test-app](./examples/test-app/README.md) ships
eight seeded bugs to exercise it against known-wrong code.

## Command line

`devharness <command>`, run from a shell inside an editor session, executes the tool in that session's own server process - against the browser and dev servers it already has open. The session is identified by process ancestry, so nothing needs to be passed in.

```sh
devharness which                                  # which session this shell belongs to
devharness call config '{"action":"status"}'      # any tool, arguments as one JSON object
devharness sessions                               # who else is reachable
devharness send a1b2c3d4 "check this" --wait=60000
```

`--session=<id>` targets a session explicitly, `--json` prints the unrendered response, and the exit code is 1 when the tool returns an error. Each session listens on a unix socket under `~/.devharness/endpoints/`, mode 0600 - not a TCP port, because the tools reachable through it evaluate JavaScript in that session's browser.

`devharness run <sequenceName>` is separate: it starts its own headless Chrome and replays a saved sequence, with no session involved.

## vs Chrome DevTools MCP

[Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) is
better at performance tracing, device emulation, advanced browser automation.

devharness adds breakpoint debugging with variable inspection, Node.js targets,
simultaneous connections, logpoints, server lifecycle, and — the part that
compounds over a long session — replayable call history and self-service recovery.

Browser-only and performance-shaped → theirs. Backend code, stepping execution,
long sessions where the agent keeps re-driving the same setup → this.

## Migrating

`cdp-tools-mcp` is deprecated on npm and points here. Tools unchanged. Package,
repo, and skill renamed.

```diff
-"args": ["-y", "cdp-tools-mcp@latest"]
+"args": ["-y", "devharness@latest"]
```

Your MCP server name (`cdp-tools`, or whatever you called it) is yours and keeps
working. Renaming it is cosmetic — but tools are addressed as
`mcp__<server-name>__<tool>`, so update project docs if you do.

State moved `.cdp-tools/` → `.devharness/` in 0.9.0. Migrates itself on first
run; profiles, config, sequences, and issues carry over. `DEVHARNESS_DIR`
supersedes `CDP_TOOLS_DIR`, which still works.

## From source

```bash
git clone https://github.com/InDate/devharness.git
cd devharness
npm install && npm run build && npm test
```

## Contributing

Issues and PRs welcome. Reporting a bug? Attach a recorded reproduction sequence.

## License

MIT
