# Tool Categories

**Connection**: `launchChrome`, `killChrome`, `connectDebugger`, `disconnectDebugger`, `getChromeStatus`, `getDebuggerStatus`, `listConnections`, `switchConnection`

**Breakpoint**: `setBreakpoint`, `removeBreakpoint`, `listBreakpoints`, `setLogpoint`, `validateLogpoint`, `resetLogpointCounter`, `setDOMBreakpoint`, `setEventBreakpoint`, `setXHRBreakpoint`

**Execution**: `pause`, `resume`, `stepOver`, `stepInto`, `stepOut`

**Inspection**: `getCallStack`, `getVariables`, `evaluateExpression`

**Source**: `loadSourceMaps`, `searchCode`, `searchFunctions`, `getSourceCode`

**Console**: `listConsoleLogs`, `getConsoleLog`, `getRecentConsoleLogs`, `searchConsoleLogs`, `clearConsole`

**Network**: `enableNetworkMonitoring`, `disableNetworkMonitoring`, `listNetworkRequests`, `getNetworkRequest`, `searchNetworkRequests`, `setNetworkConditions`

**Page**: `navigateTo`, `reloadPage`, `goBack`, `goForward`, `getPageInfo`

**DOM**: `querySelector`, `getElementProperties`, `getDOMSnapshot`

**Content**: `extractText`, `findInteractive`, `verify`

**Screenshot**: `takeScreenshot`, `takeViewportScreenshot`, `takeElementScreenshot`

**Input**: `clickElement`, `typeText`, `pressKey`, `hoverElement`

**Modal**: `detectModals`, `dismissModal`

**Storage**: `getCookies`, `setCookie`, `getLocalStorage`, `setLocalStorage`, `clearStorage`

**Server**: `server` (actions: start, stop, restart, list, logs, stopAll, setAutoRun, clearLogs, remove, monitorPort, unmonitorPort, listMonitored, acknowledgePort, acknowledgeStartup, extendStartup, cancelPendingRestart)
- Use `global: true` to access servers started from a different working directory
- `start({ watch: true, watchPaths?: [...] })`: cdp-tools watches the given paths (default: cwd) and auto-restarts the server on file changes, instead of relying on `--watch`/nodemon. Pause-aware: if a breakpoint debugger is paused on that server's inspector port, the restart queues instead of firing immediately - `cancelPendingRestart` discards a queued restart to keep debugging without it firing on resume

**Replay**: `replay` (actions: repeat, history, create, list, get, delete, export, load, listSaved, deleteSaved, run, step, finish, insert, status, cancel, recordInteraction, stopInteraction)
- `recordInteraction`: Start recording mouse, keyboard, and navigation events with visual overlay
- `stopInteraction`: Stop recording and create sequence (uses connectionReason as default name)
- `export`: Export sequence to file - supports format: sequence/playwright/puppeteer
- `repeat`: Instantly re-execute commands by history index - `replay({ action: 'repeat', indices: [0, 1, 2] })`
- Each tool response shows its history index in the "Repeat" hint for easy repetition
- Use `global: true` with `export` action to save to ~/.cdp-tools/sequences/ instead of working directory

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
