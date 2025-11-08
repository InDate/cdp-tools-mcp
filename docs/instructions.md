# LLM-CDP Debugger Usage Guidelines

This MCP server provides Chrome DevTools Protocol (CDP) debugging capabilities for JavaScript/TypeScript applications running in Chrome, Node.js, or other CDP-compatible environments.

**IMPORTANT**: These tools are under active development. When something doesn't work as expected, provide feedback immediately about:
- What you tried
- Your expected results
- What actually happened

## Quick Start Workflow

### 1. Launching Chrome for Debugging
**For web applications:**
```
launchChrome → navigateTo → setBreakpoint → interact with page
```

**For Node.js applications:**
```
connectDebugger (to existing Node.js process with --inspect flag)
```

### 2. Basic Debugging Workflow

1. **Connect to target**
   - Use `launchChrome` for browser debugging (auto-connects)
   - Use `connectDebugger` for existing Chrome/Node.js instances

2. **Set breakpoints**
   - `setBreakpoint`: Pause execution at specific lines
   - `setLogpoint`: Log values without pausing (preferred for high-frequency code)

3. **Inspect execution**
   - When paused: `getCallStack` → `getVariables` → `evaluateExpression`
   - Use `stepOver`, `stepInto`, or `stepOut` to navigate code
   - Call `resume` to continue execution

4. **Monitor runtime**
   - `listConsoleLogs` or `searchConsoleLogs`: View console output
   - `listNetworkRequests` or `searchNetworkRequests`: Inspect HTTP traffic
   - `getPageInfo`: Check current URL and page state

## Best Practices

### Breakpoint Management

- **Use conditional breakpoints** for specific scenarios:
  ```
  setBreakpoint with condition: "userId === '123'"
  ```

- **Prefer logpoints over breakpoints** for:
  - High-frequency code (loops, event handlers)
  - Production debugging
  - When you need multiple data points
  - Example: `setLogpoint` with message `"User: {user.name} clicked {event.target}"`

- **Remember to clean up**: Use `removeBreakpoint` when done, or `listBreakpoints` to review active breakpoints

### Code Search and Navigation

- **Find code before setting breakpoints**:
  - `searchCode`: Find patterns across all scripts
  - `searchFunctions`: Locate specific function definitions
  - `getSourceCode`: View code context around breakpoints

### Browser Automation

- **Page interactions** work with both breakpoints and normal execution:
  - `clickElement`, `typeText`, `pressKey` automatically handle paused state
  - `takeScreenshot` can capture current state at any time

### Debugging Node.js Applications

1. Start your Node.js app with debugging enabled:
   ```bash
   node --inspect=9229 app.js
   # or
   node --inspect-brk=9229 app.js  # pause on first line
   ```

2. Connect the debugger:
   ```
   connectDebugger with port 9229
   ```

3. Use the same debugging tools as browser debugging

### Multiple Connections

- The server supports multiple simultaneous debugging sessions
- Use `listConnections` to see active sessions
- Use `switchConnection` to change between sessions
- Each connection can debug a different Chrome tab or Node.js process

## Common Patterns

### Debugging a Bug Report

1. `launchChrome` → `navigateTo` (reproduce the issue)
2. `searchCode` or `searchFunctions` (find relevant code)
3. `setBreakpoint` or `setLogpoint` (capture state)
4. Interact with the page to trigger the bug
5. `getCallStack` + `getVariables` (inspect state when paused)
6. `evaluateExpression` (test hypotheses)

### Performance Investigation

1. `enableNetworkMonitoring`
2. `navigateTo` or reload the page
3. `searchNetworkRequests` (find slow requests)
4. `getNetworkRequest` (inspect timing details)
5. `setLogpoint` in suspected slow code paths
6. Analyze logpoint output for bottlenecks

### Frontend State Debugging

1. `querySelector` + `getElementProperties` (inspect DOM state)
2. `getLocalStorage` + `getCookies` (check stored data)
3. `evaluateExpression` (test expressions in browser console context)
4. `getDOMSnapshot` (get overview of page structure)

## Important Notes

- **Logpoint execution limits**: By default, logpoints execute 20 times before pausing to prevent log flooding. Use `resetLogpointCounter` to continue or adjust `maxExecutions` when setting logpoints.

- **Source maps**: The debugger automatically handles TypeScript and bundled code. Use `loadSourceMaps` if you need to manually specify a directory.

- **File paths**: Use full URLs for web files (`http://localhost:3000/app.js`) or `file://` URLs for local files.

- **Network monitoring**: Must be explicitly enabled with `enableNetworkMonitoring` before it captures requests.

- **Screenshot quality**: Default JPEG quality is 30 for full-page screenshots and 50 for element screenshots to balance size and clarity. Increase quality parameter for better detail.

## Tool Categories

**Connection Tools**: `launchChrome`, `killChrome`, `connectDebugger`, `disconnectDebugger`, `getChromeStatus`, `getDebuggerStatus`, `listConnections`, `switchConnection`

**Breakpoint Tools**: `setBreakpoint`, `removeBreakpoint`, `listBreakpoints`, `setLogpoint`, `validateLogpoint`, `resetLogpointCounter`

**Execution Tools**: `pause`, `resume`, `stepOver`, `stepInto`, `stepOut`

**Inspection Tools**: `getCallStack`, `getVariables`, `evaluateExpression`

**Source Tools**: `loadSourceMaps`, `searchCode`, `searchFunctions`, `getSourceCode`

**Console Tools**: `listConsoleLogs`, `getConsoleLog`, `getRecentConsoleLogs`, `searchConsoleLogs`, `clearConsole`

**Network Tools**: `enableNetworkMonitoring`, `disableNetworkMonitoring`, `listNetworkRequests`, `getNetworkRequest`, `searchNetworkRequests`, `setNetworkConditions`

**Page Tools**: `navigateTo`, `reloadPage`, `goBack`, `goForward`, `getPageInfo`

**DOM Tools**: `querySelector`, `getElementProperties`, `getDOMSnapshot`

**Screenshot Tools**: `takeScreenshot`, `takeViewportScreenshot`, `takeElementScreenshot`

**Input Tools**: `clickElement`, `typeText`, `pressKey`, `hoverElement`

**Storage Tools**: `getCookies`, `setCookie`, `getLocalStorage`, `setLocalStorage`, `clearStorage`
