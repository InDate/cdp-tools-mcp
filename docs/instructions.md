# cdp-tools Debugger Usage

Chrome DevTools Protocol debugging for JavaScript/TypeScript in Chrome, Node.js, or CDP-compatible environments.

## Quick Start

**Web apps (most common):**
```
1. launchChrome({ reference: "your-descriptive-name" })  # Auto-connects, ready immediately
2. navigate({ action: 'goto', connectionReason: "your-descriptive-name", url: "..." })
   # Navigation automatically caches interactive elements (links, buttons, inputs) for the page
3. content({ action: 'findInteractive', connectionReason: "your-descriptive-name" })
   # Shows summary of all interactive elements. Use search/types to filter
4. content({ action: 'extractText', mode: 'outline' })  # Read page content (preferred over screenshot)
5. Use other tools as needed with connectionReason parameter
```

**Alternative (rename later):**
```
1. launchChrome()                                  # Uses default "unnamed-connection-default"
2. tab({ action: 'rename', reference: "unnamed-connection-default", newReference: "your-name" })
3. Use other tools with connectionReason: "your-name"
```

**Node.js debugging:**
```
1. Start app: node --inspect=9229 app.js
2. connectDebugger({ reference: "my-app-debug", port: 9229 })
3. breakpoint({ action: 'set', connectionReason: "my-app-debug", ... })
```

## Basic Workflow

1. **Connect**:
   - `launchChrome({ reference: "name" })` - Launches AND auto-connects (ready immediately, don't call connectDebugger)
   - `connectDebugger({ reference: "name" })` - Only for existing Node.js/remote debuggers
2. **Navigate & interact**: Use connectionReason in all tool calls
   - `navigate({ action: 'goto', connectionReason: "name", url: "..." })`
   - `input({ action: 'click', connectionReason: "name", selector: "..." })`
3. **Debug**: `breakpoint({ action: 'set', connectionReason: "name", ... })`
4. **Inspect when paused**: `inspect({ action: 'getCallStack', ... })` → `inspect({ action: 'getVariables', ... })`
5. **Monitor**: `console({ action: 'list', connectionReason: "name" })`, `network({ action: 'list', connectionReason: "name" })`

## Key Practices

**Breakpoints:**
- Use conditional: `setBreakpoint` with `condition: "userId === '123'"`
- Prefer `setLogpoint` for loops/high-frequency code
- Clean up with `removeBreakpoint` or check `listBreakpoints`

**DOM/Event/XHR Breakpoints (Chrome only):**
- `setDOMBreakpoint`: Pause when element changes
  - `subtree-modified`: Children added/removed
  - `attribute-modified`: Attributes changed (class, style, etc.)
  - `node-removed`: Element deleted from DOM
- `setEventBreakpoint`: Pause when events fire (click, submit, input, keydown, etc.)
- `setXHRBreakpoint`: Pause when XHR/Fetch URL contains pattern
- Example: `breakpoint({ action: 'setDOMBreakpoint', selector: '.todo-list', domBreakpointType: 'subtree-modified' })`
- Note: DOM breakpoints use nodeIds which are invalidated on page reload

**Code search:**
- `searchCode`: Find patterns
- `searchFunctions`: Locate definitions
- `getSourceCode`: View context

**Modal handling:**
- Use `handleModals: true` on `clickElement`, `typeText`, `hoverElement`
- Strategies: `auto` (smart), `accept`, `reject`, `close`, `remove`
- Example: `clickElement({ selector: '.btn', handleModals: true, dismissStrategy: 'auto' })`
- Limitation: English-only, no Shadow DOM/iframes

**Multiple connections:**
- `listConnections` → `switchConnection`
- Each connection = separate tab/process

## Common Patterns

**Bug debugging:**
1. `launchChrome` → `navigateTo`
2. `searchCode`/`searchFunctions`
3. `setBreakpoint`/`setLogpoint`
4. Trigger bug
5. `getCallStack` + `getVariables`
6. `evaluateExpression`

**Performance:**
1. `enableNetworkMonitoring`
2. `navigateTo`
3. `searchNetworkRequests` (find slow)
4. `getNetworkRequest` (timing)
5. `setLogpoint` in slow paths

**Frontend state:**
1. `querySelector` + `getElementProperties`
2. `getLocalStorage` + `getCookies`
3. `evaluateExpression`
4. `getDOMSnapshot`

**UI verification:**
1. `content({ action: 'verify' })` - Run all default checks
2. Reports: dead buttons, small touch targets, overflow clipping, dead links, viewport issues
3. Filter checks: `checks: ['handlers', 'touch']` for specific issues
4. Available checks: `handlers`, `viewport`, `touch`, `overflow`, `clickability`, `links`, `scroll`

## Important Notes

- **After `launchChrome()`**: You are ALREADY connected. Do NOT call `connectDebugger()`. Use the `reference` parameter when launching, or rename later with `tab({ action: 'rename' })`
- **Interactive elements cache**: Navigation (goto, reload, back, forward) automatically caches all interactive elements. Cache expires after 5 minutes. `findInteractive` shows a summary by default; use `search` or `types` parameters to filter elements
- **Logpoint limits**: Default 20 executions. Use `resetLogpointCounter` or adjust `maxExecutions`
- **Expression failures**: Wrapped in try-catch, shows `[Error: message]`. Search: `searchConsoleLogs({pattern: "Logpoint Error"})`
- **CDP line mapping**: May map to nearest valid line. Use `validateLogpoint()` first
- **Source maps**: Auto-handled. Use `loadSourceMaps` for manual
- **File paths**: Full URLs (`http://localhost:3000/app.js`) or `file://`
- **Network monitoring**: Must enable with `enableNetworkMonitoring`

## Recovering from a failed tool call

- **Missing/invalid parameters**: the error includes a `continuationToken` and `missingParameters` (name/type/description/enum). Retry with just `{ continuationToken, <missing/bad field(s)> }` - don't resend everything. Expires after 5 min.
- **A validated call gets blocked by a guard** (port failure, dead server, breakpoint pause): the response footer shows `**Repeat:** replay({ action: 'repeat', indices: [N] })`. Acknowledge the guard (e.g. `server({ action: 'acknowledgePort' })`), then use that hint to resume the exact call. Don't reuse a `continuationToken` here - that's for fixing bad input, not for retrying an already-valid call.

## Restarting cdp-tools

If cdp-tools itself seems stuck or broken (not the target app), restart it yourself rather than asking the user to reconnect: `config({ action: 'restart' })`. Falls back to `kill -USR2 $(cat .cdp-tools/mcp-supervisor.pid)` via Bash if that action reports `CONFIG_RESTART_NOT_SUPERVISED` (e.g. a bare `node build/index.js`, not through the supervisor). Editing cdp-tools-mcp's own source and running `npm run build` triggers the same restart automatically via its postbuild hook. Either way, this kills any Chrome instances it launched (relaunch with `launchChrome`) but managed dev servers (`server` tool) survive and reattach automatically.

## Tool Categories

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

**Config**: `config` (actions: status, useLocal, useGlobal, reset, backup, cloneFromGlobal, show)
- `status`: Show where config is loaded from (local vs global)
- `useLocal`: Switch to project-local config (.cdp-tools/config.json)
- `useGlobal`: Switch to global config (~/.cdp-tools/config.json)
- `reset`: Reset config to defaults
- `backup`: Create timestamped backup
- `cloneFromGlobal`: Copy global config to local project
- `show`: Display current configuration
