# LLM CDP Debugger

An MCP (Model Context Protocol) server that enables LLMs to debug applications using the Chrome DevTools Protocol (CDP). This allows LLMs to set breakpoints, inspect variables, step through code, and more - providing runtime debugging capabilities instead of just static analysis.

## Features

### Core Debugging
- **Breakpoint Management**: Set, remove, and list breakpoints (including logpoints)
- **Execution Control**: Pause, resume, step over/into/out
- **Variable Inspection**: Examine call stacks, variables, and scopes
- **Source Map Support**: Debug TypeScript code with automatic source map detection
- **Universal**: Works with both Chrome browsers and Node.js applications
- **Multi-Connection Support**: Debug Chrome and Node.js simultaneously with connection management

### Browser Automation (Chrome only)
- **Page Navigation**: Navigate, reload, go back/forward
- **DOM Inspection**: Query elements, get properties, take screenshots
- **User Interaction**: Click, type, hover, press keys
- **Console Monitoring**: Track console messages with deep object serialization
- **Network Monitoring**: Capture and inspect HTTP requests/responses
- **Storage Access**: Inspect and modify localStorage, sessionStorage, cookies

## Installation

```bash
npm install
npm run build
```

## Usage

### Starting the MCP Server

```bash
npm start
```

The server uses stdio transport and can be connected to by any MCP-compatible client.

### Launching a Debuggable Target

#### For Node.js Applications

```bash
# Start your Node.js app with debugging enabled
node --inspect=9229 your-app.js

# Or for TypeScript (with ts-node)
node --inspect=9229 -r ts-node/register your-app.ts
```

#### For Chrome Browser

```bash
# Launch Chrome with remote debugging enabled
google-chrome --remote-debugging-port=9222
```

## Available Tools

### Connection Management

#### `launchChrome`
Launch Chrome with debugging enabled automatically.

**Parameters:**
- `port` (number, optional): Debugging port (default: 9222)
- `url` (string, optional): URL to open (default: blank page)

**Example:**
```json
{
  "port": 9222,
  "url": "https://example.com"
}
```

**Returns:**
- `port`: The debugging port
- `pid`: Process ID of the Chrome instance

#### `connectDebugger`
Connect to a Chrome or Node.js debugger instance. Automatically detects runtime type and enables appropriate features.

**Parameters:**
- `host` (string, optional): Debugger host (default: "localhost")
- `port` (number, optional): Debugger port (default: 9222)

**Example:**
```json
{
  "host": "localhost",
  "port": 9229
}
```

**Returns:**
- `connectionId`: Unique identifier for this connection
- `runtimeType`: `"chrome"`, `"node"`, or `"unknown"`
- `features`: Array of available features for this runtime
  - Chrome: `["debugging", "browser-automation", "console-monitoring", "network-monitoring"]`
  - Node.js: `["debugging"]`

**Chrome-Specific Behavior:**
When connecting to Chrome (port 9222):
- Console monitoring is automatically enabled
- The current page is automatically reloaded (unless it's a blank page)
- This ensures all page load console logs are captured immediately
- You can start using `listConsoleLogs()` right away without any additional setup

**Note:** You can connect to multiple debuggers simultaneously. The first connection becomes the active connection. Use `listConnections()` and `switchConnection()` to manage multiple connections.

#### `disconnectDebugger`
Disconnect from a debugger connection.

**Parameters:**
- `connectionId` (string, optional): Specific connection to disconnect (defaults to active connection)

#### `loadSourceMaps`
Load source maps from a directory (for TypeScript debugging).

**Parameters:**
- `directory` (string): Path to directory containing .js.map files

**Example:**
```json
{
  "directory": "./build"
}
```

#### `getDebuggerStatus`
Get current debugger connection status, including breakpoint count and loaded source maps.

**Parameters:**
- `connectionId` (string, optional): Specific connection to check (defaults to active connection)

**Returns:**
- `connectionId`: The connection identifier
- `connected`: Whether the connection is active
- `runtimeType`: `"chrome"`, `"node"`, or `"unknown"`
- `paused`: Whether execution is currently paused
- `breakpoints`: Number of active regular breakpoints
- `logpoints`: Number of active logpoints
- `totalBreakpoints`: Total number of breakpoints (including logpoints)
- `sourceMapCount`: Number of loaded source maps
- `consoleMonitoring`: `"active"` or `"inactive"`
- `networkMonitoring`: `"active"` or `"inactive"`
- `totalConnections`: Total number of active connections

#### `listConnections`
List all active debugger connections.

**Returns:**
Array of connections, each containing:
- `id`: Connection identifier
- `type`: Runtime type (`"chrome"`, `"node"`, or `"unknown"`)
- `host`: Connection host
- `port`: Connection port
- `active`: Whether this is the active connection
- `connected`: Connection status
- `paused`: Whether execution is paused
- `createdAt`: ISO timestamp of connection creation

**Example Response:**
```json
{
  "success": true,
  "totalConnections": 2,
  "activeConnectionId": "conn-1",
  "connections": [
    {
      "id": "conn-1",
      "type": "chrome",
      "host": "localhost",
      "port": 9222,
      "active": true,
      "connected": true,
      "paused": false,
      "createdAt": "2025-01-05T12:00:00.000Z"
    },
    {
      "id": "conn-2",
      "type": "node",
      "host": "localhost",
      "port": 9229,
      "active": false,
      "connected": true,
      "paused": true,
      "createdAt": "2025-01-05T12:01:00.000Z"
    }
  ]
}
```

#### `switchConnection`
Switch the active debugger connection.

**Parameters:**
- `connectionId` (string, required): Connection ID to switch to

**Example:**
```json
{
  "connectionId": "conn-2"
}
```

**Note:** All debugging tools operate on the active connection by default. However, you can target a specific connection by passing an optional `connectionId` parameter to any tool.

### Breakpoint Management

#### `setBreakpoint`
Set a breakpoint at a specific file and line.

**Parameters:**
- `url` (string): File URL or path (e.g., "file:///path/to/file.js")
- `lineNumber` (number): Line number (1-based, line 1 = first line)
- `columnNumber` (number, optional): Column number (1-based, column 1 = first column). If not provided, CDP will choose the best execution point on the line.

**Example:**
```json
{
  "url": "file:///Users/dev/project/app.js",
  "lineNumber": 42
}
```

**Example with column:**
```json
{
  "url": "file:///Users/dev/project/app.js",
  "lineNumber": 42,
  "columnNumber": 15
}
```

**Note:** CDP (Chrome DevTools Protocol) may map your requested line:column to the nearest valid breakpoint location. The response will show both the requested and actual locations.

#### `removeBreakpoint`
Remove a specific breakpoint.

**Parameters:**
- `breakpointId` (string): The breakpoint ID from setBreakpoint

#### `listBreakpoints`
List all active breakpoints.

### Execution Control

#### `pause`
Pause execution of the debugged program.

#### `resume`
Resume execution after being paused.

#### `stepOver`
Step to the next line (does not enter function calls).

#### `stepInto`
Step into the next function call.

#### `stepOut`
Step out of the current function.

### Inspection

#### `getCallStack`
Get the current call stack when paused at a breakpoint.

Returns an array of stack frames with function names and locations.

#### `getVariables`
Get all variables in scope for a specific call frame.

**Parameters:**
- `callFrameId` (string): The call frame ID from getCallStack
- `includeGlobal` (boolean, optional): Include global scope variables (default: false)
- `filter` (string, optional): Regex pattern to filter variable names (only applies when includeGlobal is true)
- `expandObjects` (boolean, optional): **NEW!** Expand object/array contents to show actual values instead of just type descriptions (default: true)
- `maxDepth` (number, optional): **NEW!** Maximum depth for object/array expansion (default: 2, prevents infinite recursion)

**Example:**
```json
{
  "callFrameId": "frame-id-123"
}
```

**Example with global scope filtering:**
```json
{
  "callFrameId": "frame-id-123",
  "includeGlobal": true,
  "filter": "^(fetch|document|window)$"
}
```

**Example with object expansion:**
```json
{
  "callFrameId": "frame-id-123",
  "expandObjects": true,
  "maxDepth": 3
}
```

**Note:** By default, the global scope is excluded to prevent token overflow (50K+ properties in browser environments). Use `includeGlobal: true` with a `filter` regex to access specific global variables.

**What's New:** Variables are now expanded by default! Instead of seeing `Array(3)` or `Object`, you'll see the actual contents: `["apple", "banana", "orange"]` or `{ name: "John", age: 30 }`. Use `expandObjects: false` to revert to type descriptions only.

#### `evaluateExpression`
Evaluate a JavaScript expression in the current context.

**Parameters:**
- `expression` (string): JavaScript expression to evaluate
- `callFrameId` (string, optional): Specific frame context
- `expandObjects` (boolean, optional): **NEW!** Expand object/array contents in the result (default: true)
- `maxDepth` (number, optional): **NEW!** Maximum depth for object/array expansion (default: 2)

**Example:**
```json
{
  "expression": "user.name",
  "callFrameId": "frame-id-123"
}
```

**Example with object expansion:**
```json
{
  "expression": "userData",
  "callFrameId": "frame-id-123",
  "expandObjects": true,
  "maxDepth": 3
}
```

#### `getSourceCode` **NEW!**
Get source code from a file at a specific line range. Useful for viewing code at breakpoint locations without reading files separately.

**Parameters:**
- `url` (string): The file URL or path (e.g., `file:///path/to/file.js` or `http://localhost:3000/app.js`)
- `startLine` (number, optional): Starting line number (1-based). If not provided, returns entire file.
- `endLine` (number, optional): Ending line number (1-based). If not provided with startLine, returns 10 lines.

**Example - Get specific line range:**
```json
{
  "url": "http://localhost:3000/app.js",
  "startLine": 100,
  "endLine": 120
}
```

**Example - Get 10 lines from line 50:**
```json
{
  "url": "http://localhost:3000/app.js",
  "startLine": 50
}
```

**Response includes:**
- Formatted code with line numbers
- Total lines in file
- Whether source map is available

**Benefits:**
- No need to read files separately from the debugger
- Shows actual source at breakpoint locations
- Automatically detects source maps
- Perfect for understanding context around paused execution

## Debugging with Breakpoints

### Automatic Breakpoint Handling

All interaction and navigation tools (clickElement, typeText, navigateTo, etc.) **automatically detect and handle breakpoints**. When a breakpoint is hit during execution:

1. The tool returns immediately with pause information
2. You can inspect the call stack and variables
3. Use stepOver(), stepInto(), or resume() to continue

**Example Workflow:**
```
1. Set breakpoint at a function
2. Call clickElement() to trigger the code
3. Tool returns: { pausedAtBreakpoint: true, location: {...}, callStackDepth: 3 }
4. Call getCallStack() to inspect execution state
5. Call stepOver() or resume() to continue debugging
```

No special handling or alternative tools needed - it just works!

### Conditional Breakpoints

Set breakpoints that only pause when a specific condition is true, reducing interruptions during debugging.

**How to Use:**
```json
{
  "tool": "setBreakpoint",
  "args": {
    "url": "file:///path/to/app.js",
    "lineNumber": 42,
    "condition": "userId === 123"
  }
}
```

**Examples:**
- `"count > 10"` - Only pause when count exceeds 10
- `"user.role === 'admin'"` - Only pause for admin users
- `"items.length === 0"` - Only pause when array is empty
- `"error !== null"` - Only pause when error exists

**Important Notes:**
- Conditions are JavaScript expressions evaluated in the execution context
- If the condition throws an error, the breakpoint will pause execution
- Use the same expressions you'd use in Chrome DevTools conditional breakpoints
- Logpoints are implemented as conditional breakpoints that log and return false

**Common Patterns:**
```javascript
// Only pause on specific iteration
"i === 5"

// Only pause for specific object properties
"user.id === 'abc123'"

// Only pause when combination of conditions met
"status === 'error' && retryCount > 3"

// Only pause for debugging specific edge case
"data === null || data === undefined"
```

### Logpoints

Logpoints are special breakpoints that log messages to the console without pausing execution - perfect for adding runtime logging without modifying source code.

**Parameters:**
- `url` (string): The file URL or path
- `lineNumber` (number): Line number (1-based, line 1 = first line)
- `columnNumber` (number, optional): Column number (1-based, column 1 = first column). If not provided, CDP will choose the best execution point on the line.
- `logMessage` (string): Message to log with `{expression}` interpolation
- `condition` (string, optional): Only log when this condition is true
- `includeCallStack` (boolean, optional): Include call stack in logs (default: false)
- `includeVariables` (boolean, optional): Include local variables in logs (default: false)

**Basic Usage:**
```json
{
  "tool": "setLogpoint",
  "args": {
    "url": "http://localhost:3000/app.js",
    "lineNumber": 25,
    "logMessage": "Processing user: {user.name} with ID: {user.id}"
  }
}
```

**Automatic Validation:** When CDP maps your requested location to a different line:column (which commonly happens with block-scoped variables like `const` and `let`), the tool automatically validates that all expressions in your logMessage are accessible at the actual location. If validation fails, the logpoint is rejected with helpful suggestions for better locations.

**Variable Interpolation:**
Use `{expression}` syntax to include variable values in the log message:
```json
{
  "logMessage": "Count: {count}, Total: {items.length}, Valid: {items.filter(i => i.valid).length}"
}
```

**Conditional Logging:**
Only log when a condition is met:
```json
{
  "logMessage": "Error occurred: {error.message}",
  "condition": "error !== null"
}
```

**Include Call Stack:**
```json
{
  "logMessage": "Function called",
  "includeCallStack": true
}
```

**Include Variables:**
```json
{
  "logMessage": "Checkpoint",
  "includeVariables": true
}
```

#### `validateLogpoint` **NEW!**
Validate a logpoint expression before setting it. Tests if the expressions in the log message can be evaluated and provides comprehensive feedback including actual location, code context, and alternative suggestions.

**Parameters:**
- `url` (string): The file URL or path
- `lineNumber` (number): The line number (1-based)
- `columnNumber` (number, optional): Column number (1-based). If not provided, CDP will choose the best execution point on the line.
- `logMessage` (string): Message to log with `{expression}` interpolation
- `timeout` (number, optional): Maximum time to wait for code execution in milliseconds (default: 2000ms)

**Example:**
```json
{
  "url": "http://localhost:3000/app.js",
  "lineNumber": 42,
  "logMessage": "User: {user.name} with ID: {user.id}",
  "timeout": 2000
}
```

**How it works:**
1. Sets a temporary breakpoint at the specified location
2. CDP may map this to a different line:column (the actual location)
3. Waits for code execution to hit that location (configurable timeout)
4. Tests each `{expression}` in the log message
5. Collects available variables, code context, and suggestions
6. Cleans up the temporary breakpoint

**Response includes:**
- `valid`: true/false/'unknown' - Overall validation status
- `location.requested`: Your requested line:column
- `location.actual`: Where CDP actually set the breakpoint
- `location.matched`: Whether requested and actual locations match
- `results`: Detailed results for each expression (valid/invalid with values/errors)
- `availableVariables`: List of variables in scope at the actual location
- `codeContext`: 3 lines of code around the actual location
- `suggestions`: (If validation fails) Top 3 alternative locations within ±2 lines where expressions would be valid, scored by percentage of valid expressions
- `warning`: (If locations differ) Explanation of the mapping

**Responses:**
- `valid: true` - All expressions evaluated successfully at the actual location
- `valid: false` - One or more expressions failed (see `suggestions` for better locations)
- `valid: 'unknown'` - Code hasn't executed yet (can't test without execution)

**Best practices:**
- Trigger the code path containing the logpoint line before validating
- Use validateLogpoint before setLogpoint to catch scope errors early
- Pay attention to location mapping - if CDP moves your breakpoint, check why
- Review suggestions when validation fails - they show where expressions would work
- Use the codeContext to understand what's happening at the actual location

**Troubleshooting Logpoints:**
- **Scope errors**: If a variable isn't in scope at the breakpoint location, the logpoint will log an error. **Use `validateLogpoint` to check expressions first!**
- **Expression errors**: The logpoint error messages now provide helpful tips and suggest using `validateLogpoint`
- **Timing**: Logpoints log to the **browser console**, not the terminal. Check the browser's console tab.
- **Performance**: Logpoints that run on every iteration of a loop can impact performance.
- **Line mapping**: See the section below for details on how CDP maps breakpoint locations

### Understanding Line:Column Mapping

When you set a breakpoint or logpoint, Chrome DevTools Protocol (CDP) doesn't always place it exactly where you requested. Instead, V8 (the JavaScript engine) maps your requested location to the **nearest valid breakpoint location** - a place where code actually executes.

#### Why Does This Happen?

**Block-Scoped Variables (const/let):**
The most common cause. Variables declared with `const` or `let` only exist within their block scope, and that scope starts at a very specific line:column position.

Example:
```javascript
42: function processUser(userData) {
43:   const user = userData.user;  // const exists starting at column X
44:   const password = buildPassword();  // You want to log {user} here
45:   return user;
46: }
```

If you request line 44 without a column, CDP might map to the beginning of the line (before `const` is declared), where `user` doesn't exist yet! This causes "variable not defined" errors.

**Other Causes:**
- Comments and blank lines (no code to execute)
- Function declarations (scope boundaries)
- Closing braces (end of scope)
- Optimized code (V8 may reorder operations)

#### Line and Column Numbering

**User Input:** 1-based (line 1 = first line, column 1 = first character)
**CDP Internal:** 0-based (line 0 = first line, column 0 = first character)

This tool handles the conversion automatically - you always provide 1-based numbers.

#### How This Tool Helps

**1. Automatic Validation (setLogpoint):**
When you call `setLogpoint` and CDP maps to a different location, the tool automatically:
- Validates that all `{expressions}` in your logMessage work at the actual location
- If validation fails, removes the logpoint and returns suggestions
- If validation passes but location differs, sets the logpoint with a warning

**2. Location Transparency:**
All responses show both requested and actual locations:
```json
{
  "location": {
    "requested": { "line": 44, "column": null },
    "actual": { "line": 44, "column": 15 },
    "matched": false
  }
}
```

**3. Smart Suggestions:**
When validation fails, the tool searches ±2 lines and suggests better locations:
```json
{
  "suggestions": [
    {
      "line": 45,
      "column": 3,
      "score": 100,
      "validExpressions": ["user", "password"],
      "reason": "100% of expressions are valid here"
    }
  ]
}
```

**4. Code Context:**
See what's actually happening at the location:
```
42:   function processUser(userData) {
43:     const user = userData.user;
44:     const password = buildPassword();  // ← Actual location
```

#### Best Practices

1. **Use validateLogpoint first** - Test expressions before setting logpoints
2. **Specify columnNumber when possible** - More precise than letting CDP choose
3. **Review location mapping** - If requested ≠ actual, understand why
4. **Follow suggestions** - When validation fails, try the suggested locations
5. **Check available variables** - The response shows what's in scope at the actual location
6. **Understand block scope** - `const`/`let` variables have precise scope boundaries

#### Common Scenarios

**Scenario 1: Variable not yet declared**
```javascript
Request: line 44, no column
Actual:  line 44, column 0 (start of line, before const)
Result:  {user} undefined - fails validation
Solution: Use column 15 (after const declaration) or line 45
```

**Scenario 2: End of scope**
```javascript
Request: line 46, column 1 (closing brace)
Actual:  line 46, column 1
Result:  {user} out of scope - fails validation
Solution: Use line 45 (before scope ends)
```

**Scenario 3: Successful mapping**
```javascript
Request: line 45
Actual:  line 45, column 3
Result:  {user} and {password} both valid - success with warning
```

### Console & Network Monitoring

Console monitoring is **automatically enabled** when connecting to Chrome and the page is **automatically reloaded** to capture initial logs. Network monitoring is opt-in.

**Console Monitoring (Auto-Enabled for Chrome):**

When you connect to Chrome via `connectDebugger`:
1. Console monitoring starts automatically
2. The page reloads to capture all initial console logs
3. You can immediately use `listConsoleLogs()` to see captured messages

No manual setup needed! Just connect and start debugging.

View captured messages:
```json
{
  "tool": "listConsoleLogs",
  "args": {
    "type": "error",  // Optional: filter by log, info, warn, error
    "limit": 50
  }
}
```

Search for specific messages:
```json
{
  "tool": "searchConsoleLogs",
  "args": {
    "pattern": "API.*failed",
    "flags": "i"  // Case-insensitive
  }
}
```

**Disable console monitoring** (if needed):
```json
{"tool": "disableConsoleMonitoring"}
```

**Re-enable** (if disabled):
```json
{"tool": "enableConsoleMonitoring"}
// Note: You may want to reload the page to capture logs after re-enabling
```

**Network Monitoring (Opt-In):**

Start monitoring to capture HTTP requests:
```json
{"tool": "enableNetworkMonitoring"}
```

List captured requests:
```json
{
  "tool": "listNetworkRequests",
  "args": {
    "resourceType": "xhr",  // Optional: document, stylesheet, script, xhr, fetch, etc.
    "limit": 50
  }
}
```

Search for specific requests:
```json
{
  "tool": "searchNetworkRequests",
  "args": {
    "pattern": "/api/users",
    "method": "POST",
    "statusCode": "200"
  }
}
```

**Auto-Restart on Navigation:**
Console and network monitoring automatically restart after page navigation (reload, navigateTo, goBack, goForward). You don't need to manually re-enable monitoring after navigating.

### Page Reload Timing **IMPROVED!**

The `reloadPage` tool now has better control over when navigation is considered complete, preventing timing issues with sequential operations.

**New Parameters:**
- `waitUntil`: When to consider navigation complete (default: `'load'`)
  - `'load'` - Wait for the `load` event (default, recommended)
  - `'domcontentloaded'` - Wait for DOM to be ready
  - `'networkidle0'` - Wait until no network connections for 500ms
  - `'networkidle2'` - Wait until ≤2 network connections for 500ms
- `timeout`: Maximum wait time in milliseconds (default: 30000ms / 30s)

**Example - Ensure page fully loads before clicking:**
```json
{
  "tool": "reloadPage",
  "args": {
    "waitUntil": "networkidle0"
  }
}
// Then immediately:
{
  "tool": "clickElement",
  "args": {
    "selector": "#my-button"
  }
}
```

**Benefits:**
- Sequential operations (reload → click) now work reliably
- No more "element not found" errors due to timing
- Customize wait behavior based on your needs
- Built-in timeout protection with clear error messages

**Monitoring Status:**
Check if monitoring is active:
```json
{"tool": "getDebuggerStatus"}
// Returns: { consoleMonitoring: "active", networkMonitoring: "active", ... }
```

**Best Practices:**
- Console monitoring is auto-enabled for Chrome - no setup needed
- Network monitoring should only be enabled when needed to minimize performance impact
- Use search tools instead of listing all messages/requests
- Clear console history periodically: `{"tool": "clearConsole"}`
- Network monitoring captures all requests - filter by resourceType to reduce noise

### Source Maps

Debug TypeScript code using source maps with automatic detection and mapping.

**Automatic Loading:**
Source maps are automatically detected and loaded when scripts are parsed. No manual configuration needed for most projects.

```json
// Connect to Node.js/Chrome
{"tool": "connectDebugger", "args": {"port": 9229}}

// Source maps are auto-loaded from scriptParsed events
// Set breakpoints using TypeScript file paths
{
  "tool": "setBreakpoint",
  "args": {
    "url": "file:///path/to/src/app.ts",
    "lineNumber": 42
  }
}
```

**Manual Loading:**
For projects with complex build setups, load source maps from a directory:
```json
{
  "tool": "loadSourceMaps",
  "args": {"directory": "./dist"}
}
```

**How It Works:**
1. When you set a breakpoint on a `.ts` file, the tool automatically maps it to the corresponding `.js` file location
2. When execution pauses, the tool maps the `.js` location back to the `.ts` file for display
3. Source maps are loaded from `.js.map` files adjacent to the compiled JavaScript

**Check Loaded Maps:**
```json
{"tool": "getDebuggerStatus"}
// Returns: { sourceMapCount: 5, ... }
```

**Troubleshooting:**
- Ensure `.js.map` files are generated (`"sourceMap": true` in tsconfig.json)
- Ensure source maps are in the same directory as compiled `.js` files
- For embedded source maps, no additional configuration needed
- Use `loadSourceMaps()` to manually load from build output directory

### Call Stack Navigation

When paused at a breakpoint, navigate through the call stack to understand execution flow and inspect variables at different levels.

**Basic Workflow:**

1. **Get the call stack:**
```json
{"tool": "getCallStack"}
// Returns array of frames with callFrameId, functionName, location
```

2. **Inspect variables in a specific frame:**
```json
{
  "tool": "getVariables",
  "args": {"callFrameId": "frame-id-from-call-stack"}
}
```

3. **Evaluate expressions in a frame context:**
```json
{
  "tool": "evaluateExpression",
  "args": {
    "expression": "localVariable + 1",
    "callFrameId": "frame-id-from-call-stack"
  }
}
```

**Example:**
```
Call Stack:
  0. processPayment() - app.ts:45
  1. handleCheckout() - app.ts:120
  2. onClick() - app.ts:200

// Inspect variables in frame 1 (handleCheckout)
getVariables(callFrameId: "1")
// Returns: { cart, user, total, ... }

// Evaluate expression in that context
evaluateExpression("total > 100", callFrameId: "1")
```

**Tips:**
- Frame 0 is always the current execution point
- Higher frame numbers are further up the call stack
- Each frame has its own scope - variables are frame-specific
- Use `includeGlobal: false` in getVariables() to focus on local variables

### Screenshot Best Practices

Screenshots are powerful for debugging UI issues, but they consume tokens. Follow these best practices to minimize token usage:

**Token-Saving Strategies:**

1. **Use low quality for full-page screenshots (default: 10):**
```json
{"tool": "takeScreenshot"}  // Uses quality 10 automatically
```

2. **Use clip parameter for high-quality specific regions:**
```json
{
  "tool": "takeScreenshot",
  "args": {
    "clip": {"x": 100, "y": 100, "width": 400, "height": 300},
    "quality": 30  // Higher quality for small region
  }
}
```

3. **Save to disk instead of returning base64:**
```json
{
  "tool": "takeScreenshot",
  "args": {
    "saveToDisk": "/path/to/screenshot.jpg",
    "quality": 80  // High quality since not returning via MCP
  }
}
```

4. **Use DOM inspection instead of screenshots when possible:**
```json
// Instead of screenshot, query the DOM
{"tool": "querySelector", "args": {"selector": "#error-message"}}
{"tool": "getDOMSnapshot", "args": {"maxDepth": 3}}
```

**When to Use Each Approach:**
- **Quality 10 (default)**: Quick overview of full page layout
- **Clip + Quality 30**: Debugging specific UI component
- **saveToDisk**: Need high-quality screenshot without token cost
- **DOM tools**: Debugging logic, visibility, content (no visual needed)

**Token Estimates:**
- Full page @ quality 10: ~1000-3000 tokens
- Viewport @ quality 10: ~500-1500 tokens
- Small clip @ quality 30: ~200-800 tokens
- Large clip @ quality 80: ~2000-8000 tokens

**MCP Limit:**
The tool automatically reduces quality if a screenshot exceeds 25,000 tokens (MCP response limit). If you see quality reduction warnings, consider using `clip` or `saveToDisk`.

## Example Debugging Workflow

1. Start your Node.js app with debugging:
   ```bash
   node --inspect=9229 app.js
   ```

2. Connect the debugger:
   ```json
   {"tool": "connectDebugger", "args": {"port": 9229}}
   ```

3. Set a breakpoint:
   ```json
   {
     "tool": "setBreakpoint",
     "args": {
       "url": "file:///path/to/app.js",
       "lineNumber": 25
     }
   }
   ```

4. When the breakpoint is hit, inspect the call stack:
   ```json
   {"tool": "getCallStack"}
   ```

5. Examine variables in the current frame:
   ```json
   {
     "tool": "getVariables",
     "args": {"callFrameId": "from-call-stack"}
   }
   ```

6. Evaluate expressions:
   ```json
   {
     "tool": "evaluateExpression",
     "args": {"expression": "someVariable + 1"}
   }
   ```

7. Step through code:
   ```json
   {"tool": "stepOver"}
   ```

8. Resume execution:
   ```json
   {"tool": "resume"}
   ```

## Multi-Connection Debugging

Debug multiple applications simultaneously - perfect for full-stack development where you need to debug both frontend (Chrome) and backend (Node.js) at the same time.

### How It Works

1. **Connect to Multiple Debuggers:**
   ```json
   // Connect to Chrome browser
   {"tool": "connectDebugger", "args": {"port": 9222}}
   // Returns: {"connectionId": "conn-1", "runtimeType": "chrome"}

   // Connect to Node.js backend
   {"tool": "connectDebugger", "args": {"port": 9229}}
   // Returns: {"connectionId": "conn-2", "runtimeType": "node"}
   ```

2. **View All Connections:**
   ```json
   {"tool": "listConnections"}
   // Shows all active connections with their status
   ```

3. **Switch Between Connections:**
   ```json
   {"tool": "switchConnection", "args": {"connectionId": "conn-1"}}
   // All subsequent tools operate on conn-1
   ```

4. **Independent Debugging State:**
   - Each connection maintains its own breakpoints
   - Pause/resume state is per-connection
   - Variables and call stacks are connection-specific

5. **Target Specific Connection (Advanced):**
   ```json
   // Most tools accept optional connectionId parameter
   {"tool": "getDebuggerStatus", "args": {"connectionId": "conn-2"}}
   ```

### Runtime Type Detection

The debugger automatically detects whether you're connected to Chrome or Node.js and enables appropriate features:

**Chrome Connection (`runtimeType: "chrome"`):**
- ✅ Debugging (breakpoints, stepping, inspection)
- ✅ Browser automation (DOM, navigation, clicks)
- ✅ Console monitoring (with deep object serialization)
- ✅ Network monitoring (requests, responses)
- ✅ Storage access (localStorage, cookies)
- ✅ Screenshots

**Node.js Connection (`runtimeType: "node"`):**
- ✅ Debugging (breakpoints, stepping, inspection)
- ❌ Browser automation (graceful error messages)

### Best Practices

- First connection automatically becomes active
- Use `listConnections()` regularly to track active connections
- Close unused connections to free resources: `disconnectDebugger({"connectionId": "conn-X"})`
- Browser-only tools will return helpful errors when used on Node.js connections

## TypeScript Support

The server automatically handles source maps for TypeScript debugging:

1. **Automatic Source Map Detection**: When you connect to a debugger, source maps are automatically detected and loaded via the `scriptParsed` event. No manual loading required!

2. **Manual Loading (Optional)**: For additional source maps or if auto-detection doesn't work:
   ```json
   {"tool": "loadSourceMaps", "args": {"directory": "./build"}}
   ```

3. **Check Loaded Maps**: Use `getDebuggerStatus()` to see `sourceMapCount`

4. **Set Breakpoints**: Use TypeScript file paths - they'll be automatically mapped to JavaScript

**Supported Source Map Formats:**
- Inline data URLs (embedded in JavaScript files)
- External .js.map files (relative or absolute paths)
- Both browser and Node.js environments

## Architecture

- **ConnectionManager** (`src/connection-manager.ts`): Manages multiple debugger connections
- **CDPManager** (`src/cdp-manager.ts`): Manages CDP connections and low-level operations with runtime type detection
- **PuppeteerManager** (`src/puppeteer-manager.ts`): Handles browser automation (Chrome only)
- **SourceMapHandler** (`src/sourcemap-handler.ts`): Handles TypeScript-to-JavaScript mapping with auto-detection
- **ConsoleMonitor** (`src/console-monitor.ts`): Captures console messages with deep object serialization
- **NetworkMonitor** (`src/network-monitor.ts`): Captures network requests and responses
- **Tools** (`src/tools/`): MCP tool implementations
  - `breakpoint-tools.ts`: Breakpoint and logpoint management
  - `execution-tools.ts`: Execution control (pause, resume, step)
  - `inspection-tools.ts`: Variable and expression inspection
  - `page-tools.ts`: Page navigation (Chrome only)
  - `dom-tools.ts`: DOM inspection (Chrome only)
  - `input-tools.ts`: User interaction simulation (Chrome only)
  - `screenshot-tools.ts`: Screenshot capture with token optimization (Chrome only)
  - `console-tools.ts`: Console log inspection (Chrome only)
  - `network-tools.ts`: Network request inspection (Chrome only)
  - `storage-tools.ts`: localStorage/cookie access (Chrome only)
- **Error Helpers** (`src/error-helpers.ts`): Structured error responses with suggestions
- **Debugger-Aware Wrapper** (`src/debugger-aware-wrapper.ts`): Automatic breakpoint detection for browser automation
- **Main Server** (`src/index.ts`): MCP server initialization and coordination

## Troubleshooting

### Connection Issues

- Ensure the target application is running with debugging enabled
- Check that the port matches (9222 for Chrome, 9229 for Node.js by default)
- Verify no firewall is blocking the connection

### Breakpoints Not Working

- For TypeScript, source maps are auto-loaded, but verify with `getDebuggerStatus()` that `sourceMapCount > 0`
- If auto-detection fails, manually load with `loadSourceMaps({"directory": "./dist"})`
- Verify the file path is correct (use `file://` URLs for local files)
- Check that the code has been loaded by the runtime before setting breakpoints

### Source Map Issues

- Ensure your tsconfig.json has `"sourceMap": true`
- Verify .js.map files exist alongside your .js files
- Source maps are auto-detected via `scriptParsed` events - no manual loading needed in most cases
- Check `getDebuggerStatus()` to see if source maps were loaded

### Runtime Type / Feature Availability

- Check `connectDebugger` response to see `runtimeType` and available `features`
- Browser automation tools (DOM, screenshots, etc.) only work with Chrome connections
- Node.js connections support debugging only (breakpoints, stepping, inspection)
- Use `listConnections()` to see all connections and their types

## Limitations and Known Issues

### **Runtime Separation**
- **Chrome and Node.js run in separate processes** - You must connect to each separately
- Setting a breakpoint on server code while connected to Chrome will fail (and vice versa)
- For full-stack debugging, use multi-connection support:
  ```json
  {"tool": "connectDebugger", "args": {"port": 9222}}  // Chrome
  {"tool": "connectDebugger", "args": {"port": 9229}}  // Node.js
  {"tool": "listConnections"}  // See both connections
  {"tool": "switchConnection", "args": {"connectionId": "conn-2"}}  // Switch between them
  ```

### **Variable Inspection Workflow**
- Variables can only be inspected when **execution is paused** at a breakpoint
- Workflow: `setBreakpoint()` → trigger code → wait for pause → `getCallStack()` → `getVariables()`
- Logpoints (`setLogpoint`) are better for observing values without pausing

### **Tool Call Efficiency**
- Debugging workflows can require multiple sequential tool calls
- Each challenge may need 5-10 calls: set breakpoint, trigger code, check logs, inspect network, etc.
- Consider using logpoints for passive observation vs. breakpoints for detailed inspection

### **Server-Side Observability**
- No direct access to Node.js process stdout/stderr
- Server logs only visible if logged to browser console via API responses
- Use `console.log()` in Node.js code and check `listConsoleLogs()` after API calls

### **Screenshot Token Costs**
- Full-page screenshots can exceed token limits
- Use `saveToDisk` parameter to save to file instead: `{"saveToDisk": "/path/to/screenshot.jpg"}`
- Or use `clip` parameter to capture specific regions at higher quality

### **Source Map Edge Cases**
- Auto-detection works for most cases but may fail for:
  - Complex build tools with unusual paths
  - Inline source maps in minified code
  - Source maps in non-standard locations
- Fallback: Use `loadSourceMaps({"directory": "./dist"})` for manual loading

## Contributing

This is a prototype for demonstrating runtime debugging capabilities for LLMs. Feel free to extend and improve it based on your needs.

## License

MIT
