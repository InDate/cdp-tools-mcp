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
4. Use other tools as needed with connectionReason parameter
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

## Important Notes

- **After `launchChrome()`**: You are ALREADY connected. Do NOT call `connectDebugger()`. Use the `reference` parameter when launching, or rename later with `tab({ action: 'rename' })`
- **Interactive elements cache**: Navigation (goto, reload, back, forward) automatically caches all interactive elements. Cache expires after 5 minutes. `findInteractive` shows a summary by default; use `search` or `types` parameters to filter elements
- **Logpoint limits**: Default 20 executions. Use `resetLogpointCounter` or adjust `maxExecutions`
- **Expression failures**: Wrapped in try-catch, shows `[Error: message]`. Search: `searchConsoleLogs({pattern: "Logpoint Error"})`
- **CDP line mapping**: May map to nearest valid line. Use `validateLogpoint()` first
- **Source maps**: Auto-handled. Use `loadSourceMaps` for manual
- **File paths**: Full URLs (`http://localhost:3000/app.js`) or `file://`
- **Network monitoring**: Must enable with `enableNetworkMonitoring`
- **Screenshot quality**: Default 30 (full), 50 (element). Adjust for clarity

## Tool Categories

**Connection**: `launchChrome`, `killChrome`, `connectDebugger`, `disconnectDebugger`, `getChromeStatus`, `getDebuggerStatus`, `listConnections`, `switchConnection`

**Breakpoint**: `setBreakpoint`, `removeBreakpoint`, `listBreakpoints`, `setLogpoint`, `validateLogpoint`, `resetLogpointCounter`

**Execution**: `pause`, `resume`, `stepOver`, `stepInto`, `stepOut`

**Inspection**: `getCallStack`, `getVariables`, `evaluateExpression`

**Source**: `loadSourceMaps`, `searchCode`, `searchFunctions`, `getSourceCode`

**Console**: `listConsoleLogs`, `getConsoleLog`, `getRecentConsoleLogs`, `searchConsoleLogs`, `clearConsole`

**Network**: `enableNetworkMonitoring`, `disableNetworkMonitoring`, `listNetworkRequests`, `getNetworkRequest`, `searchNetworkRequests`, `setNetworkConditions`

**Page**: `navigateTo`, `reloadPage`, `goBack`, `goForward`, `getPageInfo`

**DOM**: `querySelector`, `getElementProperties`, `getDOMSnapshot`

**Screenshot**: `takeScreenshot`, `takeViewportScreenshot`, `takeElementScreenshot`

**Input**: `clickElement`, `typeText`, `pressKey`, `hoverElement`

**Modal**: `detectModals`, `dismissModal`

**Storage**: `getCookies`, `setCookie`, `getLocalStorage`, `setLocalStorage`, `clearStorage`

**Content**: `extractText`, `findInteractive`
