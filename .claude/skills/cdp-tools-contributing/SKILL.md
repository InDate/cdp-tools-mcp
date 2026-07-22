---
name: cdp-tools-contributing
description: Workflow guidance for contributing to the cdp-tools-mcp codebase itself (as opposed to using it to debug some other app) - building, testing, hot-reloading a live MCP connection while iterating, and keeping the shipped docs/Agent Skill in sync when tools change. Use when editing files under src/, adding or changing an MCP tool, or debugging why a rebuild didn't take effect in a live session.
---

# Contributing to cdp-tools-mcp

This skill is for working ON this repo's own source, not for using its tools to debug a target app (for that, see `skills/cdp-tools/` - the skill this package ships to its own consumers).

## Build & test loop

- `npm run build` - `tsc` + dashboard build. Also runs a `postbuild` hook (`scripts/signal-supervisor.mjs`) that sends `SIGUSR2` to a running `mcp-supervisor` process (if any), so a live Claude Code session picks up the change without a manual `/mcp` reconnect.
- `npm test` / `npm run test:run` - vitest. Tests are colocated as `*.test.ts` next to the code they cover.
- `npm run build:verify` - build + `scripts/verify-mcp.js` + `scripts/measure-startup.mjs`. Run this before anything release-shaped; it's also what `prepublishOnly` runs.

## Hot-reload semantics (mcp-supervisor)

`mcp-supervisor.js` is the actual `bin` entrypoint; it supervises the real server (`build/index.js`) as a child process. On `SIGUSR2` (sent automatically by the postbuild hook, manually via `kill -USR2 $(cat .cdp-tools/mcp-supervisor.pid)`, or via the `config({ action: 'restart' })` tool - see `src/self-restart.ts` - which just wraps the same pidfile-read-and-signal) it restarts that child and sends `notifications/tools/list_changed`.

What that means while iterating on this repo with a live Claude Code session attached:
- Any Chrome instances the old child launched are killed - call `launchChrome` again after a rebuild.
- Managed dev servers (the `server` tool) survive the restart and reattach automatically - they're tracked outside the child process's lifetime.
- You do not need to tell the user to reconnect `/mcp` after `npm run build` - it already happened.
- `config({ action: 'restart' })` is a real tool call and thus part of the frozen tool list itself - if you're testing a change to the restart mechanism, be aware the *old* code's version of that tool is what actually runs until the restart it triggers completes.

## Where things live

- `src/tools/*.ts` - one file per tool family, action-based schemas (see any existing file for the pattern before adding a new tool).
- `src/index.ts` - tool registration, and `loadInstructions()` which loads the MCP `instructions` field from `docs/mcp-instructions.md`.
- `docs/instructions.md` - full human-readable tool reference, linked from `docs/README.md` and the root `README.md`.
- `docs/mcp-instructions.md` - short quick-start sent over the MCP protocol on every connection; deliberately kept small since MCP clients inject it unconditionally.
- `skills/cdp-tools/` - the Agent Skills-format mirror of `docs/instructions.md`, shipped to consumers for progressive disclosure (see `docs/README.md#agent-skill`).
- `docs/messages.md` - source of truth for tool response text (`## MESSAGE_ID` sections), parsed at runtime by `messages.ts`'s `MessageManager`. Not a static template file that's loaded into context - this only costs tokens when the corresponding tool call actually happens, so it's fine for these to be as detailed as needed (unlike tool schema descriptions, see below).

**Keep tool schema descriptions (the `.describe()` calls and `createTool()`'s first argument) terse.** They're sent to every session at `listTools` time regardless of whether the tool is ever called - that's a fixed token cost paid by every session, not a progressive-disclosure surface. Put the "why/when/what happens" detail in `skills/cdp-tools/SKILL.md` or `references/` instead, which only load when a client actually activates the skill.

**When you add, rename, or change the behavior of a tool**, update all of `docs/instructions.md`, `docs/mcp-instructions.md` (only if it affects the quick-start), `skills/cdp-tools/SKILL.md` / `skills/cdp-tools/references/tool-categories.md`, and `docs/messages.md` (if it returns new response types) as needed - they currently have to be kept in sync by hand, there's no generation step.

## Config philosophy

Per project convention (see `docs/working_with_llm_notes.md`): LLMs editing this server's own behavior are optimistic and sometimes wrong. Any LLM-driven config change needs a manual override path the user can reach without going through the LLM - don't add a setting that's only reachable through an agent's tool calls.
