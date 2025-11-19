# cdp-tools Debugger Usage

Chrome DevTools Protocol debugging for JavaScript/TypeScript in Chrome, Node.js, or CDP-compatible environments.

## Quick Start

**Web apps:**
```
launchChrome → navigateTo → setBreakpoint → interact
```

**Node.js:**
```
node --inspect=9229 app.js
connectDebugger (port: 9229)
```

## Basic Workflow

1. **Connect**: `launchChrome` (browser) or `connectDebugger` (existing instance)
2. **Set breakpoints**: `setBreakpoint` or `setLogpoint` (non-pausing)
3. **Inspect when paused**: `getCallStack` → `getVariables` → `evaluateExpression`
4. **Navigate**: `stepOver`, `stepInto`, `stepOut`, `resume`
5. **Monitor**: `listConsoleLogs`, `listNetworkRequests`, `getPageInfo`

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
