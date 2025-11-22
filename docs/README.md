# cdp-tools-mcp Documentation

Chrome DevTools Protocol tools for AI-assisted debugging and browser automation.

## Why Use cdp-tools-mcp?

Instead of just analyzing static code, AI assistants can now:
- **Debug running applications in real-time** - Set breakpoints and inspect live state
- **Observe actual runtime behavior** - See how your code actually executes
- **Test and validate fixes immediately** - Make changes and verify them instantly
- **Automate browser interactions** - Test UI flows and capture issues
- **Provide insights based on live execution data** - Understand complex runtime scenarios

## Documentation

| Guide | Description |
|-------|-------------|
| [Installation](./installation.md) | Setup for Claude Code, Claude Desktop, and from source |
| [Debugging](./debugging.md) | Breakpoints, stepping, variables, call stacks, source maps |
| [Automation](./automation.md) | Navigation, element interaction, screenshots, storage |
| [Replay](./replay.md) | Record and replay command sequences |
| [Troubleshooting](./troubleshooting.md) | Common issues and solutions |
| [API Reference](./instructions.md) | Tool schemas and MCP instructions |
| [Message Templates](./messages.md) | Response format templates |

## Quick Start

```bash
# Claude Code CLI
claude mcp add cdp-tools -- npx -y cdp-tools-mcp
```

```javascript
// Launch Chrome and start debugging
launchChrome({ reference: 'my debug session' })
navigate({ action: 'goto', url: 'http://localhost:3000', connectionReason: 'my-debug-session' })

// Set a breakpoint
breakpoint({ action: 'set', url: 'http://localhost:3000/app.js', lineNumber: 42, connectionReason: 'my-debug-session' })

// When paused, inspect state
inspect({ action: 'getCallStack', connectionReason: 'my-debug-session' })
inspect({ action: 'getVariables', callFrameId: '0', connectionReason: 'my-debug-session' })
```

## Core Concepts

### Connection Management

cdp-tools-mcp supports multiple simultaneous connections:

- **Chrome connections**: Each browser tab can have its own connection
- **Node.js connections**: Debug backend applications separately
- **Connection references**: Use descriptive 3-word names (e.g., "user profile page")

### Smart Element Caching

When you navigate to a page, cdp-tools automatically:

1. **Caches all clickable elements** - Links, buttons, and inputs are discovered and stored
2. **Records viewport positions** - Tracks which elements are visible
3. **Enables instant filtering** - Search cached elements without re-querying the DOM
4. **Expires after 5 minutes** - Fresh data on subsequent navigations

## Need Help?

- Try the [Test Application](../examples/test-app/README.md) for hands-on practice
- File issues at https://github.com/InDate/cdp-tools-mcp/issues
