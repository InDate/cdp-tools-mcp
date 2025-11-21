# cdp-tools-mcp Comprehensive Guide

This guide provides detailed information about using cdp-tools-mcp for debugging and browser automation.

## Table of Contents

- [Why Use cdp-tools-mcp?](#why-use-cdp-tools-mcp)
- [Installation](#installation)
- [Core Concepts](#core-concepts)
- [Runtime Debugging](#runtime-debugging)
- [Browser Automation](#browser-automation)
- [Multi-Agent Support](#multi-agent-support)
- [Common Patterns](#common-patterns)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)

## Why Use cdp-tools-mcp?

Instead of just analyzing static code, AI assistants can now:
- **Debug running applications in real-time** - Set breakpoints and inspect live state
- **Observe actual runtime behavior** - See how your code actually executes
- **Test and validate fixes immediately** - Make changes and verify them instantly
- **Automate browser interactions** - Test UI flows and capture issues
- **Provide insights based on live execution data** - Understand complex runtime scenarios

## Installation

### Claude Code CLI

```bash
claude mcp add --transport stdio cdp-tools npx cdp-tools-mcp
```

### Claude Desktop

Add to your config file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
**Linux**: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "cdp-tools": {
      "command": "npx",
      "args": ["-y", "cdp-tools-mcp"]
    }
  }
}
```

Restart and ask Claude to debug your application.

### From Source

```bash
git clone https://github.com/InDate/cdp-tools-mcp.git
cd cdp-tools-mcp
npm install
npm run build
npm start
```

## Core Concepts

### Connection Management

cdp-tools-mcp supports multiple simultaneous connections:

- **Chrome connections**: Each browser tab can have its own connection
- **Node.js connections**: Debug backend applications separately
- **Connection references**: Use descriptive 3-word names (e.g., "user-profile-page")

### Smart Element Caching

When you navigate to a page, cdp-tools automatically:

1. **Caches all clickable elements** - Links, buttons, and inputs are discovered and stored
2. **Records viewport positions** - Tracks which elements are visible
3. **Enables instant filtering** - Search cached elements without re-querying the DOM
4. **Expires after 5 minutes** - Fresh data on subsequent navigations

**Cache keys**: `host + pathname + search` ensures each page has isolated cache

## Runtime Debugging

### Setting Breakpoints

**Regular breakpoints:**
```javascript
breakpoint({
  action: 'set',
  url: 'http://localhost:3000/app.js',
  lineNumber: 42,
  connectionReason: 'my-debug-session'
})
```

**Conditional breakpoints:**
```javascript
breakpoint({
  action: 'set',
  url: 'http://localhost:3000/app.js',
  lineNumber: 42,
  condition: 'userId === "123"',
  connectionReason: 'my-debug-session'
})
```

**Logpoints** (non-breaking):
```javascript
breakpoint({
  action: 'setLogpoint',
  url: 'http://localhost:3000/app.js',
  lineNumber: 42,
  logMessage: 'User {userId} with role {userRole}',
  includeCallStack: true,
  maxExecutions: 50,
  connectionReason: 'my-debug-session'
})
```

### Execution Control

When paused at a breakpoint:

```javascript
// Get call stack
inspect({ action: 'getCallStack', connectionReason: 'my-debug-session' })

// Get variables in current scope
inspect({ action: 'getVariables', callFrameId: '0', connectionReason: 'my-debug-session' })

// Evaluate expression
inspect({ action: 'evaluateExpression', expression: 'user.email', connectionReason: 'my-debug-session' })

// Step over
execution({ action: 'stepOver', connectionReason: 'my-debug-session' })

// Resume
execution({ action: 'resume', connectionReason: 'my-debug-session' })
```

### Source Maps

TypeScript debugging works automatically:

1. Source maps are auto-detected and loaded
2. Breakpoints map to original TypeScript files
3. Variable names match your source code
4. Call stacks show TypeScript file paths

## Browser Automation

### Navigation with Smart Caching

```javascript
// Navigate - automatically caches clickable elements
navigate({
  action: 'goto',
  url: 'https://myapp.com/login',
  connectionReason: 'test-session'
})
// Response: "144 total clickable elements (53 in viewport)"

// Find elements instantly from cache
content({
  action: 'findClickable',
  connectionReason: 'test-session'
})
// Shows only viewport-visible elements by default

// Search ALL cached elements
content({
  action: 'findClickable',
  search: 'login',
  connectionReason: 'test-session'
})
// Searches across entire page cache
```

### Element Interaction

```javascript
// Click element
input({
  action: 'click',
  selector: '#login-button',
  handleModals: true,
  connectionReason: 'test-session'
})

// Type text
input({
  action: 'type',
  selector: '#username',
  text: 'testuser@example.com',
  connectionReason: 'test-session'
})

// Hover
input({
  action: 'hover',
  selector: '.dropdown-menu',
  connectionReason: 'test-session'
})
```

### Monitoring

**Console logs:**
```javascript
// List console messages
console({
  action: 'list',
  type: 'error',
  limit: 50,
  connectionReason: 'test-session'
})

// Search console
console({
  action: 'search',
  pattern: 'API.*failed',
  connectionReason: 'test-session'
})
```

**Network requests:**
```javascript
// Enable monitoring
network({
  action: 'enable',
  connectionReason: 'test-session'
})

// Search requests
network({
  action: 'search',
  pattern: '/api/users',
  connectionReason: 'test-session'
})

// Get specific request
network({
  action: 'get',
  id: 'request-123',
  includeBody: true,
  connectionReason: 'test-session'
})
```

### Storage

```javascript
// Get localStorage
storage({
  action: 'getLocalStorage',
  connectionReason: 'test-session'
})

// Get cookies
storage({
  action: 'getCookies',
  url: 'https://myapp.com',
  connectionReason: 'test-session'
})

// Set localStorage
storage({
  action: 'setLocalStorage',
  key: 'theme',
  value: 'dark',
  connectionReason: 'test-session'
})
```

## Multi-Agent Support

### Tab Management

Nested Claude agents can each manage their own browser tabs:

```javascript
// Agent 1 creates a tab
tab({
  action: 'create',
  reference: 'agent-one-tab',
  url: 'https://site1.com'
})

// Agent 2 creates another tab
tab({
  action: 'create',
  reference: 'agent-two-tab',
  url: 'https://site2.com'
})

// List all tabs
tab({ action: 'list' })

// Switch between tabs
tab({
  action: 'switch',
  reference: 'agent-one-tab'
})
```

### Multi-Runtime Debugging

Debug Chrome and Node.js simultaneously:

**Chrome:**
```javascript
launchChrome({ reference: 'frontend-debug' })
navigate({ action: 'goto', url: 'http://localhost:3000', connectionReason: 'frontend-debug' })
```

**Node.js (separate connection):**
```bash
# Start Node with debugging
node --inspect=9229 server.js
```

```javascript
connectDebugger({ reference: 'backend-debug', port: 9229 })
breakpoint({ action: 'set', url: 'file:///app/server.js', lineNumber: 50, connectionReason: 'backend-debug' })
```

## Common Patterns

### Bug Hunting

1. **Launch and navigate**
```javascript
launchChrome({ reference: 'bug-hunt' })
navigate({ action: 'goto', url: 'http://localhost:3000/problematic-page', connectionReason: 'bug-hunt' })
```

2. **Monitor console errors**
```javascript
console({ action: 'list', type: 'error', connectionReason: 'bug-hunt' })
```

3. **Set breakpoints**
```javascript
breakpoint({
  action: 'set',
  url: 'http://localhost:3000/app.js',
  lineNumber: 150,
  connectionReason: 'bug-hunt'
})
```

4. **Trigger the bug and inspect**
```javascript
input({ action: 'click', selector: '#trigger-button', connectionReason: 'bug-hunt' })
// Pauses at breakpoint
inspect({ action: 'getCallStack', connectionReason: 'bug-hunt' })
inspect({ action: 'getVariables', callFrameId: '0', connectionReason: 'bug-hunt' })
```

### Performance Investigation

1. **Enable network monitoring**
```javascript
network({ action: 'enable', connectionReason: 'perf-check' })
```

2. **Navigate and capture requests**
```javascript
navigate({ action: 'goto', url: 'http://localhost:3000', connectionReason: 'perf-check' })
```

3. **Find slow requests**
```javascript
network({ action: 'list', connectionReason: 'perf-check' })
// Look for long timing.duration values
```

4. **Set logpoints in suspect code**
```javascript
breakpoint({
  action: 'setLogpoint',
  url: 'http://localhost:3000/api-client.js',
  lineNumber: 75,
  logMessage: 'API call started at {Date.now()}',
  connectionReason: 'perf-check'
})
```

### Automated Testing

1. **Navigate with element caching**
```javascript
navigate({ action: 'goto', url: 'https://myapp.com/signup', connectionReason: 'test-flow' })
```

2. **Find form elements from cache**
```javascript
content({ action: 'findInput', search: 'email', connectionReason: 'test-flow' })
```

3. **Fill form**
```javascript
input({ action: 'type', selector: '#email', text: 'test@example.com', connectionReason: 'test-flow' })
input({ action: 'type', selector: '#password', text: 'testpass123', connectionReason: 'test-flow' })
```

4. **Submit and monitor**
```javascript
input({ action: 'click', selector: '#submit-button', connectionReason: 'test-flow' })
console({ action: 'recent', count: 10, connectionReason: 'test-flow' })
network({ action: 'search', pattern: '/api/signup', connectionReason: 'test-flow' })
```

## Configuration

### Multi-Session Support

Each MCP server instance automatically uses a unique debugging port to prevent conflicts when running multiple LLM sessions simultaneously.

**Port Configuration:**
- **Auto-assigned**: Ports auto-assigned starting from 9222
- **Manual override**: Set `MCP_DEBUG_PORT` environment variable
- **Valid range**: 1024-65535

### Environment Variables

```bash
# Set specific debug port
export MCP_DEBUG_PORT=9223

# Enable debug logging (not yet implemented)
# export CDP_TOOLS_DEBUG=1
```

## Troubleshooting

### Chrome Connection Issues

**Problem**: "Chrome is already running on port X"

**Solutions**:
- Use `killChrome({ reason: "restart needed" })` to stop existing instance
- Launch on different port: `launchChrome({ port: 9224 })`
- Check if another process is using the port: `lsof -i :9222`

### Breakpoint Not Hitting

**Problem**: Breakpoint set but never pauses

**Solutions**:
- Verify file URL matches exactly (use `searchCode` to find the right path)
- Check source maps are loading correctly
- Ensure code path is actually executed (add `console.log` to verify)
- Try setting logpoint first to confirm location is reachable

### Element Not Found

**Problem**: Selector doesn't match any elements

**Solutions**:
- Use `content({ action: 'findClickable' })` to see available elements
- Check element is in viewport: might need to scroll first
- Wait for dynamic content: element may load asynchronously
- Try broader selector (class instead of ID)

### Cache Not Working

**Problem**: `findClickable` shows "no cache" or stale data

**Solutions**:
- Cache expires after 5 minutes - navigate again to refresh
- Cache is page-specific - each URL has separate cache
- Clear navigation: `navigate({ action: 'goto', ... })` rebuilds cache

### Node.js Connection Fails

**Problem**: Cannot connect to Node.js debugger

**Solutions**:
- Ensure Node started with `--inspect` flag
- Check port number matches (default 9229)
- Verify Node process is still running
- Try `--inspect=0.0.0.0:9229` if connecting remotely

## Comparison with Chrome DevTools MCP

### cdp-tools-mcp Strengths

- ✅ **Breakpoint debugging** - Set breakpoints, step through code, inspect variables
- ✅ **Node.js support** - Debug backend applications
- ✅ **Multi-connection** - Chrome and Node.js simultaneously
- ✅ **Logpoints** - Non-breaking logging without code changes
- ✅ **Source maps** - TypeScript debugging
- ✅ **Smart element caching** - Instant element discovery

**Best for**: Backend debugging, full-stack debugging, code execution analysis

### Chrome DevTools MCP Strengths

- ✅ **Performance tracing** - DevTools Performance panel integration
- ✅ **Advanced automation** - Puppeteer-based with auto-waiting
- ✅ **Form handling** - Dedicated form fill tools
- ✅ **Device emulation** - Mobile/tablet testing

**Best for**: Performance optimization, UI automation, browser testing

### Using Both Together

Both servers can coexist in your MCP configuration:

```json
{
  "mcpServers": {
    "cdp-tools": {
      "command": "npx",
      "args": ["-y", "cdp-tools-mcp"]
    },
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "@chromedevtools/mcp-server"]
    }
  }
}
```

Use cdp-tools for debugging and Chrome DevTools MCP for performance/automation.

## Advanced Topics

### Custom Port Management

```javascript
// Launch on specific port
launchChrome({ port: 9224, reference: 'custom-port' })

// Connect to existing debugger on custom port
connectDebugger({ port: 9230, reference: 'external-debugger' })

// Multiple Chrome instances
launchChrome({ port: 9222, reference: 'instance-one' })
launchChrome({ port: 9223, reference: 'instance-two' })
```

### Logpoint Expressions

Logpoints support variable interpolation:

```javascript
// Simple variables
logMessage: 'User ID: {userId}'

// Object properties
logMessage: 'User: {user.email}, Role: {user.role}'

// Function calls
logMessage: 'Timestamp: {Date.now()}'

// Complex expressions
logMessage: 'Cart total: {cart.items.reduce((sum, item) => sum + item.price, 0)}'
```

### Modal Handling

Auto-dismiss modals during interactions:

```javascript
input({
  action: 'click',
  selector: '#submit',
  handleModals: true,
  dismissStrategy: 'auto',  // or 'accept', 'reject', 'close', 'remove'
  connectionReason: 'test'
})
```

**Strategies**:
- `auto`: Smart detection (cookies → accept, GDPR → accept, etc.)
- `accept`: Click accept/agree/ok buttons
- `reject`: Click reject/decline buttons
- `close`: Click X/close buttons
- `remove`: Remove modal from DOM

**Limitations**: English only, no Shadow DOM/iframe support

## Need Help?

- Check [Tool Instructions](./instructions.md) for MCP tool reference
- Review [Message Templates](./messages.md) for response formats
- Try the [Test Application](../examples/test-app/README.md) for hands-on practice
- File issues at https://github.com/InDate/cdp-tools-mcp/issues
