---
name: cdp-tools
description: Debug JavaScript/TypeScript running in Chrome or Node.js via the cdp-tools MCP server - set breakpoints and logpoints, inspect call stacks and variables, monitor console/network activity, automate browser interactions (navigate, click, type, screenshot), manage dev servers, and record/replay reproduction sequences with automated fix verification. Use whenever a task involves debugging a running app, reproducing or verifying a bug, tracing runtime behavior, or the user mentions breakpoints, Chrome DevTools, CDP, replay sequences, or cdp-tools MCP tools (launchChrome, navigate, breakpoint, inspect, replay, server, issues, etc.).
compatibility: Requires the cdp-tools-mcp MCP server to be connected (tools such as launchChrome, breakpoint, inspect, replay, server, issues).
---

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

Two different mechanisms fix two different failure points - don't confuse them.

**1. Missing/invalid parameters -> `continuationToken` (fix and resubmit, cheaply)**

If a call fails validation (`code: 'MISSING_PARAMETERS'` or `'INVALID_PARAMS'`), the error includes a `continuationToken` and a `missingParameters` list (name/type/description/enum). Don't resend the whole call - retry with just:
```
{ continuationToken: '<token>', <only the missing/bad field(s)> }
```
The server merges this with what you already sent and re-validates. Repeat (same token) until it succeeds. The token expires after 5 minutes. This only applies to calls that never passed validation in the first place - it has nothing to do with guard blocks below.

**2. A validated call gets blocked by a guard (port failure, dead server, breakpoint pause, etc.) -> `replay`**

Once a call passes validation, cdp-tools records it (even if a guard then blocks it before the handler runs) and every response footer includes a hint like:
```
**Repeat:** `replay({ action: 'repeat', indices: [N] })`
```
Acknowledge whatever blocked it (e.g. `server({ action: 'acknowledgePort' })`, `server({ action: 'acknowledgeStartup' })`), then use that `replay` hint to resume the exact same call - do not reconstruct the arguments by hand, and do not try to reuse a `continuationToken` for this case (that mechanism is for fixing bad input, not for retrying a call that was already valid).

## Restarting cdp-tools

If cdp-tools itself seems stuck or broken (not the target app), restart it yourself rather than asking the user to reconnect - don't wait to be told to.

- **Preferred**: `config({ action: 'restart' })`. Under the hood this reads `.cdp-tools/mcp-supervisor.pid` and sends the running mcp-supervisor process a `SIGUSR2`, the same signal `npm run build`'s postbuild hook sends automatically after a rebuild. The supervisor replays the original MCP `initialize` handshake to the freshly spawned child, so the host session never needs to reconnect.
- If that returns `CONFIG_RESTART_NOT_SUPERVISED` (this server isn't running through the supervisor - e.g. a bare `node build/index.js`), fall back to Bash: `kill -USR2 $(cat .cdp-tools/mcp-supervisor.pid)`.
- If it returns `CONFIG_RESTART_STALE_PID`, the supervisor died without cleaning up its pidfile - ask the user to run `/mcp` to reconnect.

**Expect the triggering call itself to come back as an error - that's normal, not a failure.** In practice `config({ action: 'restart' })` almost never returns its own `CONFIG_RESTART_REQUESTED` success message: the old process gets torn down before it can flush that response, so the supervisor's restart-coordinator answers with a synthesized `MCP error -32000: MCP server is restarting; this request will not receive a response from the previous process. Please retry.` instead. Just retry the next call - it'll hit the freshly restarted (and by then ready) process. Two things to expect on that next call: it runs against a new PID (visible in tool response footers), and any acknowledged monitored-port failures (`server({ action: 'acknowledgePort' })`) reset and may need re-acknowledging, since that state lived in the process that just got replaced.

Either way, a restart kills any Chrome instances this session launched (relaunch with `launchChrome`), but managed dev servers (`server` tool) survive and reattach automatically. `config({ action: 'reload' })` is different and lighter-weight - it hot-applies most `config.json` edits without a restart; a restart is only needed for `tools.enabled`/`tools.disabled` changes (the tool list is frozen at server startup) or when the process itself is actually stuck.

## Tool Categories

The full list of tools grouped by category (connection, breakpoint, execution, inspection, source, console, network, page, DOM, content, screenshot, input, modal, storage, server, replay, config) is not needed for most tasks. Load it only when you need to look up a specific tool name or action:

[references/tool-categories.md](references/tool-categories.md)
