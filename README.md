# LLM CDP Debugger

An MCP (Model Context Protocol) server that enables LLMs to debug applications using the Chrome DevTools Protocol (CDP). This allows LLMs to set breakpoints, inspect variables, step through code, and more - providing runtime debugging capabilities instead of just static analysis.

## Features

- **Breakpoint Management**: Set, remove, and list breakpoints
- **Execution Control**: Pause, resume, step over/into/out
- **Variable Inspection**: Examine call stacks, variables, and scopes
- **Source Map Support**: Debug TypeScript code with automatic mapping
- **Universal**: Works with both Chrome browsers and Node.js applications

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
Connect to a Chrome or Node.js debugger instance.

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

#### `disconnectDebugger`
Disconnect from the debugger.

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

### Breakpoint Management

#### `setBreakpoint`
Set a breakpoint at a specific file and line.

**Parameters:**
- `url` (string): File URL or path (e.g., "file:///path/to/file.js")
- `lineNumber` (number): Line number (1-based)
- `columnNumber` (number, optional): Column number (0-based)

**Example:**
```json
{
  "url": "file:///Users/dev/project/app.js",
  "lineNumber": 42
}
```

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

**Example:**
```json
{
  "callFrameId": "frame-id-123"
}
```

#### `evaluateExpression`
Evaluate a JavaScript expression in the current context.

**Parameters:**
- `expression` (string): JavaScript expression to evaluate
- `callFrameId` (string, optional): Specific frame context

**Example:**
```json
{
  "expression": "user.name",
  "callFrameId": "frame-id-123"
}
```

## Debugging with Breakpoints

### Important: Click Events and Breakpoints

When debugging with breakpoints, **do not use `clickElement`** as it will block waiting for JavaScript execution to complete. Instead:

**Option 1: Use `dispatchClick`** (Recommended for debugging)
```json
{"tool": "dispatchClick", "args": {"selector": ".button"}}
```
This dispatches the click immediately without waiting, allowing breakpoints to pause execution.

**Option 2: Use `evaluateExpression`**
```json
{
  "tool": "evaluateExpression",
  "args": {"expression": "document.querySelector('.button').click()"}
}
```

**Workflow:**
1. Set breakpoints FIRST
2. Use `dispatchClick` to trigger the code
3. Execution pauses at breakpoint
4. Inspect variables, step through code
5. Resume when done

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

## TypeScript Support

The server automatically handles source maps for TypeScript debugging:

1. Build your TypeScript project with source maps enabled (already configured in tsconfig.json)
2. Load the source maps:
   ```json
   {"tool": "loadSourceMaps", "args": {"directory": "./build"}}
   ```
3. Set breakpoints using TypeScript file paths - they'll be automatically mapped to JavaScript

## Architecture

- **CDPManager** (`src/cdp-manager.ts`): Manages CDP connections and operations
- **SourceMapHandler** (`src/sourcemap-handler.ts`): Handles TypeScript-to-JavaScript mapping
- **Tools** (`src/tools/`): MCP tool implementations
  - `breakpoint-tools.ts`: Breakpoint management
  - `execution-tools.ts`: Execution control
  - `inspection-tools.ts`: Variable and expression inspection
- **Main Server** (`src/index.ts`): MCP server initialization and coordination

## Troubleshooting

### Connection Issues

- Ensure the target application is running with debugging enabled
- Check that the port matches (9222 for Chrome, 9229 for Node.js by default)
- Verify no firewall is blocking the connection

### Breakpoints Not Working

- For TypeScript, make sure source maps are loaded with `loadSourceMaps`
- Verify the file path is correct (use `file://` URLs for local files)
- Check that the code has been loaded by the runtime before setting breakpoints

### Source Map Issues

- Ensure your tsconfig.json has `"sourceMap": true`
- Verify .js.map files exist alongside your .js files
- Load source maps before setting breakpoints in TypeScript files

## Contributing

This is a prototype for demonstrating runtime debugging capabilities for LLMs. Feel free to extend and improve it based on your needs.

## License

MIT
