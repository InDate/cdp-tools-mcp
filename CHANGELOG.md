# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed - BREAKING

- **`replay({ action: 'run' })` no longer blocks.** It validates the request, registers a run, and returns immediately with a `runId` (in the text and in `_meta.replay.runId`); the sequence executes in the background.
  - **Migration:** pass `wait: true` to keep the old blocking behaviour and get the full result in one call: `replay({ action: 'run', name: '...', wait: true })`. Anything that awaited `run` and read its result (scripts, prompts, other tooling) must either add `wait: true` or poll `replay({ action: 'status', runId })`.
  - `status` with a `runId` reports a running run's current step, and returns the complete final result (step results, debug state, `killChromeOnFinish` outcome) once the run settles. Without `runId` it shows the paused step-through session plus all recent runs.
  - `cancel` with a `runId` aborts that run - it takes effect at the next step boundary (a tool call already in flight is not interrupted; per-step cancellation is #110). A bare `cancel` still drops the paused session first, or cancels the only executing run.
  - Concurrent runs are supported, including two runs of the same sequence; the `runId` distinguishes them. Nested sequences (`conditional` flows, `replay run` steps - which are forced to `wait: true`) belong to their parent run and never register separately.
  - Settled runs are kept in memory for 30 minutes (max 50 records). Unknown/expired ids - including every id from before a server restart, which also kills in-flight runs - return `REPLAY_RUN_NOT_FOUND`.
  - Internal callers that need the result (`issues workOn`/`resolve` auto-replay, the `cdp-tools-mcp run` CLI) now pass `wait: true` and behave exactly as before.

### Added
- **WebSocket Health** (#128): `network({ action: 'sockets' })` reports the WebSocket lifecycle - what opened, what closed and after how long, and which hit frame errors. Puppeteer raises no page event for sockets, so these come from the CDP `Network` domain. `replay({ action: 'run'|'runAll', requireSockets: true })` diffs that health across a run and fails it when a socket closed or errored while it executed, so a sequence that passes every assertion while its transport was down is reported as the failure it is. The diff is against the start, so a socket already dead beforehand is not blamed on the sequence, and unlike a final "is it up now" assertion it catches a drop that recovered mid-run.
  - Sockets opened inside a **Web Worker** are included (#129). They belong to the worker's own CDP target and emit nothing on the page session, so the monitor auto-attaches to child targets (`Target.setAutoAttach` with `waitForDebuggerOnStart`, which holds the worker before its first line so a socket opened at worker boot is not missed) and enables `Network` on each. `sockets` output labels every entry with its owning target - `[page]` or `[worker]` - because for an app that syncs from a worker the real transport is the `[worker]` line, and the `[page]` ones may be nothing but the dev server's HMR socket.
- **Self-Restart Tool**: `config({ action: 'restart' })` restarts cdp-tools itself via the mcp-supervisor (`src/self-restart.ts` reads `.cdp-tools/mcp-supervisor.pid` and sends it `SIGUSR2` - the same mechanism the `postbuild` hook and a manual `kill -USR2` already used), so a session can recover a stuck/broken server or apply `tools.enabled`/`tools.disabled` changes without shelling out or asking the user to reconnect. Returns `CONFIG_RESTART_NOT_SUPERVISED` if this server isn't running through the supervisor (e.g. bare `node build/index.js`), or `CONFIG_RESTART_STALE_PID` if the pidfile points at a dead process.
- **Agent Skill**: Bundled an [Agent Skills](https://agentskills.io)-compatible skill at `skills/cdp-tools/` (with `references/tool-categories.md`) mirroring `docs/instructions.md`, so skills-aware clients (e.g. Claude Code) can load the full workflow guide and tool catalog progressively instead of it living entirely in the MCP `instructions` field. The MCP `instructions` payload itself (`docs/mcp-instructions.md`) is now a short quick-start plus a pointer to the skill, since MCP clients inject `instructions` into every session unconditionally. See [docs/README.md](docs/README.md#agent-skill) for setup.
  - **Install nudge**: On startup, the server checks whether the skill is already symlinked into a scanned location (`.claude/skills/cdp-tools` or `.agents/skills/cdp-tools`, project- or user-level). If not found anywhere, the `instructions` payload asks the model to offer setting it up (never to symlink it in unprompted). The nudge stops appearing once installed.
- **Page-Parser Plugins**: `content({ action: 'parse', name })` runs a user-provided parser plugin in the page and returns its JSON output; `content({ action: 'parse' })` (no name) lists available plugins and flags which match the current URL. Plugins are loaded from `~/.cdp-tools/parsers/` (global) or `./.cdp-tools/parsers/` (project, overrides global), dynamically imported at call time (cache-busted), so adding or editing a parser needs no rebuild/restart. Each plugin default-exports `{ name, description, match?, waitFor?, extract }` where `waitFor`/`extract` run in the page. No plugins ship with the package — write your own; see [docs/parser-plugins.md](docs/parser-plugins.md) for the contract and a worked AI Overview example.
- **Replay Retargeting**: `replay({ action: 'run', baseUrl })` rewrites the origin of every absolute URL in a sequence (startUrl + command params) so one recorded sequence runs against any deployment; `startUrl` on `run` replaces the entry URL for that run only (e.g. a freshly minted link). Neither survives a mid-run pause/step resume.
- **UI Verification** (#26): `content({ action: 'verify' })` detects dead buttons, viewport issues, touch targets, overflow clipping, dead links, horizontal scroll
- **DOM Change Detection** (#27): Input actions report DOM changes via MutationObserver (added/removed elements, visibility changes)
- **Replay Agent**: `.claude/agents/replay-agent.md` for building sequences through investigation
- **Variable Inspection Fallbacks**: `getVariables` gracefully degrades when data exceeds token limits (#20)
- **Breakpoint Pause Detection**: Input actions (click, type, hover) now detect and report when they trigger breakpoints
- **TOON Format**: Token-Oriented Object Notation for compact inspection output (~58% token reduction)
- **Webpack Eval Support**: Code search (`searchCode`, `searchFunctions`) now extracts actual source lines from webpack eval wrappers instead of showing unhelpful `eval(__webpack_require__...)` lines
- **Lazy Source Map Loading**: Source maps are now registered and loaded on-demand instead of eagerly, improving startup performance
  - Size limits prevent performance issues (1MB inline, 10MB file)
  - Support for URL-encoded data URIs (not just base64)
  - Concurrent load protection prevents duplicate loads
  - Error tracking for debugging without blocking operations

### Fixed
- **Cache-Busting Breakpoints**: Breakpoints now work across rebuilds when scripts have changing query params (e.g., `app.js?v=123`)
  - Falls back to base URL matching when exact URL not found
  - Prefers most recently loaded script when multiple matches exist
- **Connection Reference Lookups**: References are now normalized (lowercase, trimmed, spaces→hyphens) for more flexible lookups

### Changed
- `loadSourceMaps` tool now registers maps for lazy loading and reports count; actual loading happens on-demand
- Long code search results truncated to 200 chars to prevent huge responses from minified code

---

## [0.2.0] - 2025-11-22

### Added
- **Enhanced Replay System**: Major improvements to command replay for workflow automation
  - Connection injection: Replay sequences across different Chrome sessions
  - Variable substitution: Replace text inputs with new values during replay
  - `intoHistory` option: Load sequences into history without executing
  - Step/total timeout configuration for replay control
  - Auto-launch Chrome if no active connection
  - Element validation after navigation/click actions
- **Chrome Lifecycle Tracking**: Track Chrome process close events with reasons
  - Close reasons: `inactivity`, `manual`, `crash`, `external`, `signal`, `unknown`
  - View close history via `getChromeStatus()`
  - Better debugging for unexpected Chrome terminations
- **Password Popup Prevention**: Automatically disable Chrome's password manager
  - Prevents save password prompts that block automation
  - Disables password leak detection popups
- **Startup Metrics**: Track MCP server startup performance
  - Measure import, port reservation, server creation times
  - View metrics when debug logging is enabled
  - New `npm run startup:measure` script for diagnostics

### Changed
- Simplified replay sequence storage format (commands inline, not indices)
- `recordCommand` is now async for better error handling
- Improved inactivity cleanup logging for debugging

### Fixed
- Circular dependency issues with port configuration (extracted to dedicated module)

### Technical
- Port configuration extracted to `src/port-config.ts`
- Added stdin close handler for proper cleanup when parent process terminates
- Added uncaught exception and unhandled rejection handlers

---

## [0.1.0] - 2025-11-14

### Added
- Initial release of CDP Tools MCP
- 72 tools for Chrome DevTools Protocol debugging
- Connection management (Chrome and Node.js)
- Breakpoint and logpoint support
- Execution control (pause, resume, step)
- Variable inspection and code search
- Network monitoring and request inspection
- Console log monitoring and search
- Browser automation (navigation, interaction)
- DOM inspection and querying
- Screenshot and PDF generation
- Storage access (cookies, localStorage)
- Content extraction and modal handling
- Token-efficient responses with smart truncation
- Automatic file saving for large data
- Pagination support for logs and requests

### Features
- **Runtime Debugging**: Set breakpoints, inspect variables, step through code
- **Logpoints**: Add logging without code changes (max 20 executions by default)
- **Network Analysis**: Monitor HTTP traffic with request/response inspection
- **Browser Automation**: Automate interactions to reproduce bugs
- **Token Optimization**: Smart truncation, file saving, and pagination
- **Multi-Connection**: Debug Chrome and Node.js simultaneously
- **Source Map Support**: Debug TypeScript with automatic source map loading

### Technical
- Built with Model Context Protocol SDK
- Uses Chrome DevTools Protocol via chrome-remote-interface
- TypeScript implementation with full type safety
- Comprehensive error handling and validation
- Zod schemas for parameter validation

[0.1.0]: https://github.com/InDate/cdp-tools-mcp/releases/tag/v0.1.0
