---
name: cdp-tools-contributing
description: Workflow guidance for contributing to the cdp-tools-mcp codebase itself (as opposed to using it to debug some other app) - building, testing, hot-reloading a live MCP connection while iterating, and keeping the shipped docs/Agent Skill in sync when tools change. Use when editing files under src/, adding or changing an MCP tool, or debugging why a rebuild didn't take effect in a live session.
---

# Contributing to cdp-tools-mcp

This skill is for working ON this repo's own source, not for using its tools to debug a target app (for that, see `skills/cdp-tools/` - the skill this package ships to its own consumers).

## Build & test loop

- `npm run build` - `tsc` + dashboard build. Also runs a `postbuild` hook (`scripts/signal-supervisor.mjs`) that sends `SIGUSR2` to a running `mcp-supervisor` process (if any), so a live Claude Code session picks up the change without a manual `/mcp` reconnect.
- `npm test` / `npm run test:run` - vitest. Tests are colocated as `*.test.ts` next to the code they cover.
- `npm run build:verify` - build + `scripts/verify-mcp.js` + `scripts/measure-startup.mjs`. Run this before anything release-shaped. (`prepublishOnly` runs `test:run` **and** `build:verify`, but it is a backstop for a hand-rolled publish that should never happen - see below.)
- `npm run stress:suspend` - drives the built supervisor as a real process to exercise idle suspend and orphan reaping: requests landing inside the teardown window, RSS/fd across many suspend cycles, a real Chrome and dev server actually being released, signal collisions, the kill escalation, and reaping across several trees. Needs a `npm run build` first, takes a few minutes, and is deliberately outside `npm test`. Run named scenarios (`-- race leak`), change the loop count (`-- --cycles=200`), or skip the slow real-Chrome one (`-- --skip=release`). Set `STRESS_VERBOSE=1` to see supervisor stderr. Touch it whenever `src/supervisor/` changes.

## Releasing

**`npm version patch` (or `minor` / `major`) is the entire release.** Nothing else is needed, and nothing else should be done:

1. `version` hook stamps the new version into the shipped Agent Skill (`scripts/sync-skill-version.mjs`).
2. `postversion` hook runs `git push && git push --tags` - **automatically**. There is no separate push step, and no confirmation.
3. The pushed `v*` tag triggers `.github/workflows/publish.yml`, which on CI runs `npm run test:run`, `npm run build:verify`, and `npm publish --provenance`.

So the moment the tag lands, the package is being published. **Never run `npm publish` by hand** - it is a second, unverified path to the registry that bypasses the CI gate, and it will collide with the workflow run the tag already started.

Two things that follow from the push being automatic, and that are easy to get wrong:

- **`git push` with no arguments pushes the whole branch, not just the version commit.** Every local commit sitting on `main` ships with the release. There is no such thing as "committed but held back locally" once someone runs `npm version` - so never describe a commit that way as if a later bump wouldn't carry it out, and make sure the branch is exactly what should be released *before* bumping.
- **Do not offer to push after `npm version`, and do not say a release "wasn't published".** Both already happened. Confirm with `gh run list --workflow=publish.yml` and `npm view cdp-tools-mcp version` rather than guessing.

## Hot-reload semantics (mcp-supervisor)

`mcp-supervisor.js` is the actual `bin` entrypoint; it supervises the real server (`build/index.js`) as a child process. On `SIGUSR2` (sent automatically by the postbuild hook, manually via `kill -USR2 $(cat .cdp-tools/mcp-supervisor.pid)`, or via the `config({ action: 'restart' })` tool - see `src/self-restart.ts` - which just wraps the same pidfile-read-and-signal) it restarts that child and sends `notifications/tools/list_changed`.

What that means while iterating on this repo with a live Claude Code session attached:
- Any Chrome instances the old child launched are killed - call `launchChrome` again after a rebuild.
- Managed dev servers (the `server` tool) survive the restart and reattach automatically - they're tracked outside the child process's lifetime.
- You do not need to tell the user to reconnect `/mcp` after `npm run build` - provided the postbuild hook actually found a supervisor to signal, which it now reports either way (see below).
- `config({ action: 'restart' })` is a real tool call and thus part of the frozen tool list itself - if you're testing a change to the restart mechanism, be aware the *old* code's version of that tool is what actually runs until the restart it triggers completes.

### When a rebuild doesn't take effect

`npm run build` now says whether it reached anything: `Sent SIGUSR2 to mcp-supervisor (PID n)` means the live session has your change, and `No pidfile ... nothing to reload` means it does not (reconnect `/mcp`). If you are debugging behaviour that contradicts the source you just edited, read that line before reading the code - it silently printed nothing before, and stale-code debugging is indistinguishable from a real bug.

The pidfile is last-writer-wins across supervisors, so a supervisor only deletes it on exit when it still names that process (`src/supervisor/pidfile.ts`). Deleting it unconditionally let a stale supervisor, exiting hours later, disable a live session's hot reload.

**That line is a claim about a pid, not proof your session reloaded.** The build signals whoever is named in *this repo's* pidfile; when the session is supervised from a different project directory, that is someone else's supervisor and the signal lands harmlessly there. Ask the running server instead:

```
config({ action: 'status' })
```

It reports `Built:` (mtime of the `build/index.js` the process actually loaded, read at startup), `Running:` (which file that is), and `pid` / `supervisor`. A `Built` timestamp older than the build you just ran means you are talking to the previous code - reconnect `/mcp`, or find the supervisor that is actually serving you. Do this before concluding that behaviour contradicts your source: several hours of debugging a fix that already worked came from not being able to ask this question.

## Tool failures are THROWN, not returned

`executeToolCall` (`src/index.ts`) converts any `isError` response into a thrown `ToolError` (`src/tool-error.ts`) carrying that response. **Code downstream of it that branches on `result.isError` is dead**, and a test whose fake `executeToolCall` *returns* isError responses will happily cover that dead branch while the live path goes untested. That mismatch shipped several bugs: absent-element conditions failing whole runs, `LAUNCH_FAILED` never reaching the user, a leaked verification tab.

So:

- **Wrap every fake `executeToolCall` in `productionShaped()`** (`src/test-support/fake-execute-tool-call.ts`), which raises isError responses the way the real one does. Import the real `ToolError` rather than re-declaring its shape.
- **Classify failures by `_errorId`, not by message text.** `createErrorResponse` attaches it, and `ToolError` carries the whole response, so `err.response._errorId` is available in-process. `isElementNotFoundFailure()` in `messages.ts` is the worked example - it lives beside the template it matches.
- **Build fixtures with the real helpers** (`createErrorResponse`, `getErrorMessage`, `formatCodeBlock`, `webStorageMeta`). Hand-written response text drifts: fixtures asserted `Element not found: ...` for a year while `MessageManager` actually emits `Error: Element not found: ...`.

## Read `_meta`, never rendered text

Structured results live in `_meta` (`src/tool-response.ts`). Anything deciding *behaviour* from a tool response must read that, because rendered text mixes our formatting with page-controlled data. Every instance of grepping the markdown has been a bug: a localStorage value of `"null"` read as absent, a URL containing a comma compared truncated, `**error**` counted inside a logged message, `\d{3}` matching any three digits as an HTTP status.

If the data you need isn't in `_meta`, add it there (as `ContentToolMeta` was for `findInteractive`) rather than parsing the string.

Corollary: **don't add a text fallback "just in case"**. Production has exactly one shape; a fallback no code path reaches is untestable and hides drift. The one deliberate exception is a raw library exception with no `_errorId` at all.

## Where things live

- `src/tools/*.ts` - one file per tool family, action-based schemas (see any existing file for the pattern before adding a new tool).
- `src/index.ts` - tool registration, and `loadInstructions()` which loads the MCP `instructions` field from `docs/mcp-instructions.md`.
- `docs/instructions.md` - full human-readable tool reference, linked from `docs/README.md` and the root `README.md`.
- `docs/mcp-instructions.md` - short quick-start sent over the MCP protocol on every connection; deliberately kept small since MCP clients inject it unconditionally.
- `skills/cdp-tools/` - the Agent Skills-format mirror of `docs/instructions.md`, shipped to consumers for progressive disclosure (see `docs/README.md#agent-skill`).
- `docs/messages.md` - source of truth for tool response text (`## MESSAGE_ID` sections), parsed at runtime by `messages.ts`'s `MessageManager`. Not a static template file that's loaded into context - this only costs tokens when the corresponding tool call actually happens, so it's fine for these to be as detailed as needed (unlike tool schema descriptions, see below).

**Keep tool schema descriptions (the `.describe()` calls and `createTool()`'s first argument) terse.** They're sent to every session at `listTools` time regardless of whether the tool is ever called - that's a fixed token cost paid by every session, not a progressive-disclosure surface. Put the "why/when/what happens" detail in `skills/cdp-tools/SKILL.md` or `references/` instead, which only load when a client actually activates the skill.

**Skill and reference prose is a token budget, not a page count.** Say the thing once, in the fewest words that survive being wrong. Cut restatement, worked examples that repeat an earlier one, and any sentence that only reassures the reader. If a paragraph and a table say the same thing, keep the table.

**Comments are not journals.** A comment says what the code does or why the non-obvious choice was made - in one line where possible. It does not narrate history ("this used to...", "before the fix..."), argue with a previous author, or restate the line below it. Git holds the history; the comment holds the constraint. If the reason needs a paragraph, it belongs in the docs, not above the function.

**When you add, rename, or change the behavior of a tool**, update all of `docs/instructions.md`, `docs/mcp-instructions.md` (only if it affects the quick-start), `skills/cdp-tools/SKILL.md` / `skills/cdp-tools/references/tool-categories.md`, and `docs/messages.md` (if it returns new response types) as needed - they currently have to be kept in sync by hand, there's no generation step.

## Config philosophy

Per project convention (see `docs/working_with_llm_notes.md`): LLMs editing this server's own behavior are optimistic and sometimes wrong. Any LLM-driven config change needs a manual override path the user can reach without going through the LLM - don't add a setting that's only reachable through an agent's tool calls.
