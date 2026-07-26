# Tool Categories

Most tools are **grouped**: one tool name plus an `action` param, e.g.
`navigate({ action: 'goto', url })`, not a separate `navigateTo` tool. The
actions below are the complete enums accepted by each tool.

Nearly every tool also takes `connectionReason` to pick which connection it
runs against (see the skill's Quick Start).

**Connection**: `launchChrome`, `killChrome`, `resetChromeLauncher`, `getChromeStatus`, `connectDebugger`, `disconnectDebugger`, `getDebuggerStatus`, `listConnections`, `switchConnection`
- These are individual tools, not actions
- `launchChrome` also connects - don't follow it with `connectDebugger`

**Tab**: `tab` (actions: list, create, rename, switch, close)

**Breakpoint**: `breakpoint` (actions: set, remove, list, setLogpoint, validate, resetCounter, waitForScript, setDOMBreakpoint, setEventBreakpoint, setXHRBreakpoint, await)
- `waitForScript`: block until a script URL loads, so you can breakpoint code that isn't parsed yet
- `await`: wait for a breakpoint to be hit rather than polling
- `setLogpoint`: non-pausing logging with `{expr}` interpolation, `maxExecutions` to cap noise

**Execution**: `execution` (actions: pause, resume, stepOver, stepInto, stepOut, acknowledge)

**Inspection**: `inspect` (actions: getCallStack, getVariables, evaluateExpression, searchCode, searchFunctions)

**Source**: `getSourceCode`, `loadSourceMaps`
- Individual tools, not actions

**Console**: `console` (actions: list, get, recent, search, clear, setObjectDepth)

**Network**: `network` (actions: list, get, search, enable, disable, setConditions)

**Page**: `navigate` (actions: goto, reload, back, forward, info)

**DOM**: `dom` (actions: querySelector, getProperties, snapshot)

**Content**: `content` (actions: extractText, findInteractive, verify, parse)

**Screenshot**: `screenshot` (actions: fullPage, viewport, element, pdf)

**Input**: `input` (actions: click, type, press, hover, focus, focusNext, focusPrevious, drag, scroll, mousemove, pinch)

**Modal**: `detectModals`, `dismissModal`
- Individual tools, not actions

**Storage**: `storage` (actions: getCookies, setCookie, getLocalStorage, setLocalStorage, clear)

**HTTP / assertions**: `request`, `assert`, `saveToDisk`
- `request`: HTTP request as a sequence step. `destination: 'node'` sends it from the MCP server process (no browser, no CORS/cookies); `destination: 'browser'` runs `fetch()` in a connected tab (that page's cookies/session/origin). `saveAs` captures the response for later steps
- `assert`: assert a condition as a sequence step, failing the sequence if false - use `{{var:name.path}}` templates against values captured by a prior `request({ saveAs })`

**Issues**: `issues` (actions: list, create, workOn, resolve, acknowledge, comment)
- `create`/`comment`: track bugs and features as Markdown issues, optionally linked to a replay sequence
- `workOn`: start on an issue, auto-replaying its linked sequence
- **Comment as you go.** When working an issue, `comment` on it at the start (what you're about to change and why) and again when done (what you actually changed, files touched, tests added, and anything you found that contradicts the issue as written). The issue becomes the durable record - someone reviewing later reads the timeline, not your diff. Comment on surprises too: a repro that doesn't reproduce, a root cause elsewhere, or a fix you rejected and why
- `resolve` is **human-gated**: it opens a browser overlay and only a person clicking Fixed/Not Fixed can close the issue. Don't call it unattended - it will wait ~150s and then fail with `ISSUES_RESOLVE_TIMEOUT`. Record what you found with `comment` and ask the user to run `resolve` themselves
- `acknowledge`: acknowledge pending bugs to unblock other tools

**Server**: `server` (actions: start, stop, restart, list, logs, stopAll, setAutoRun, clearLogs, remove, monitorPort, unmonitorPort, listMonitored, acknowledgePort, acknowledgeStartup, extendStartup, cancelPendingRestart)
- Use `global: true` to access servers started from a different working directory
- `start({ watch: true, watchPaths?: [...] })`: cdp-tools watches the given paths (default: cwd) and auto-restarts the server on file changes, instead of relying on `--watch`/nodemon. Pause-aware: if a breakpoint debugger is paused on that server's inspector port, the restart queues instead of firing immediately - `cancelPendingRestart` discards a queued restart to keep debugging without it firing on resume

**Replay**: `replay` (actions: history, create, list, get, delete, export, load, listSaved, deleteSaved, run, step, finish, insert, status, cancel, repeat, runFromLog, recordInteraction)
- `recordInteraction`: record mouse, keyboard, and navigation events with a visual overlay
- `export`: export a sequence to file - `format: sequence | playwright | puppeteer`
- `repeat`: instantly re-execute commands by history index - `replay({ action: 'repeat', indices: [0, 1, 2] })`. Each tool response shows its history index in the "Repeat" hint
- `run`: `startUrl` overrides the stored start URL for one run; `baseUrl` retargets every absolute URL at another deployment's origin
- Use `global: true` with `export` to save to ~/.cdp-tools/sequences/ instead of the working directory

**Dashboard**: `dashboard` (actions: open, status, stop)

**Debug logging**: `setDebugLogging`, `getDebugLoggingStatus`

**Config**: `config` (actions: status, useLocal, useGlobal, reset, backup, cloneFromGlobal, show, listTools, reload, restart)
- `status`: Show where config is loaded from (local vs global)
- `useLocal`: Switch to project-local config (.cdp-tools/config.json)
- `useGlobal`: Switch to global config (~/.cdp-tools/config.json)
- `reset`: Reset config to defaults
- `backup`: Create timestamped backup
- `cloneFromGlobal`: Copy global config to local project
- `show`: Display current configuration
- `listTools`: List all toggleable tools with status and dependency conflicts
- `reload`: Re-read config.json now (also happens automatically on file edits, ~250ms debounce). Doesn't apply `tools.enabled`/`tools.disabled` - those need `restart`
- `restart`: Restart cdp-tools itself via the mcp-supervisor (see "Restarting cdp-tools" above) - use when the server seems stuck/broken, or to apply `tools.enabled`/`tools.disabled` changes
