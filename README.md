# cdp-tools-mcp

[![npm version](https://img.shields.io/npm/v/cdp-tools-mcp.svg)](https://www.npmjs.com/package/cdp-tools-mcp)
[![license](https://img.shields.io/npm/l/cdp-tools-mcp.svg)](https://github.com/InDate/cdp-tools-mcp/blob/main/LICENSE)

> Enable AI assistants like Claude to debug your JavaScript/TypeScript applications in real-time using Chrome DevTools Protocol

```bash
claude mcp add --transport stdio cdp-tools npx cdp-tools-mcp@latest
```

## What is this?

An MCP (Model Context Protocol) server that gives AI assistants the ability to:
- 🐛 **Set breakpoints** and step through your code
- 🔍 **Inspect variables** and call stacks at runtime
- 📊 **Monitor console logs** and network requests
- 🌐 **Automate browser interactions** with smart element discovery
- 🔄 **Debug both Chrome and Node.js** applications simultaneously
- 🤖 **Multi-agent support**: Nested Claude agents can each manage their own browser tabs

**Perfect for:** Debugging complex issues with AI assistance, automated testing, runtime code analysis, and understanding unfamiliar codebases.

## Quick Start

### Claude Code CLI

```bash
claude mcp add --transport stdio cdp-tools npx cdp-tools-mcp
```

### Claude Desktop

Add to your config file (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

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

Restart and start debugging! Ask Claude to help debug your application.

## Key Features

### Runtime Debugging
- **Breakpoint Management**: Set, remove, and list breakpoints (including conditional breakpoints and logpoints)
- **Execution Control**: Pause, resume, step over/into/out
- **Variable Inspection**: Examine call stacks, variables, and scopes at runtime
- **Source Map Support**: Debug TypeScript code with automatic source map detection
- **Universal**: Works with both Chrome browsers and Node.js applications

### Browser Automation (Chrome only)
- **Smart Navigation**: Navigate with automatic clickable element caching
- **Element Discovery**: Navigation automatically caches all interactive elements (links, buttons, inputs) with viewport-aware filtering
- **DOM Inspection**: Query elements, get properties, take screenshots
- **User Interaction**: Click, type, hover, press keys
- **Console & Network Monitoring**: Track logs and HTTP requests with deep serialization
- **Storage Access**: Inspect and modify localStorage, sessionStorage, cookies

### Multi-Agent Support
- **Tab Management**: Nested Claude agents can each create and manage their own browser tabs within the same Chrome instance
- **Connection Management**: Debug Chrome and Node.js simultaneously with isolated connections
- **Port Handling**: Automatic port assignment prevents conflicts when running multiple sessions

## Example Usage

**Web Debugging:**
```
1. Ask Claude: "Launch Chrome and navigate to https://myapp.com"
2. Claude launches browser, caches all clickable elements
3. Ask: "Find all login-related links"
4. Claude searches cached elements instantly
5. Ask: "Click the login button and watch for errors"
6. Claude interacts and monitors console/network
```

**Node.js Debugging:**
```
1. Start your app: node --inspect=9229 app.js
2. Ask Claude: "Connect to my Node app and set a breakpoint in user.js line 42"
3. Trigger the code path
4. Ask: "What are the values of userId and userRole?"
5. Claude inspects variables and provides insights
```

## Documentation

- **[Comprehensive Guide](./docs/GUIDE.md)** - Detailed usage, examples, and advanced patterns
- **[Tool Instructions](./docs/instructions.md)** - MCP tool reference and best practices
- **[Message Templates](./docs/messages.md)** - Response formats and error messages

## Why cdp-tools-mcp?

**vs Chrome DevTools MCP:**
- ✅ **Breakpoint debugging** - Set breakpoints, step through code, inspect variables at runtime
- ✅ **Node.js debugging** - Debug backend applications, not just browsers
- ✅ **Multi-connection support** - Debug Chrome and Node.js simultaneously
- ✅ **Logpoints** - Add logging without modifying source code

**Best for:** Backend debugging, full-stack debugging, understanding code execution flow

[Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) is better for performance analysis, device emulation, and advanced browser automation.

## Try It Out

Check out our [test application](./examples/test-app/README.md) with 8 debug challenges covering DOM bugs, network issues, breakpoints, logpoints, and multi-connection debugging.

## Installation from Source

```bash
git clone https://github.com/InDate/cdp-tools-mcp.git
cd cdp-tools-mcp
npm install
npm run build
npm start
```

## Contributing

Contributions welcome! This is a prototype for demonstrating runtime debugging capabilities for LLMs. Feel free to extend and improve it based on your needs.

## License

MIT

## What's New

### Latest Features
- **Smart Element Caching**: Navigation automatically caches all clickable elements for instant discovery
- **Viewport-Aware Filtering**: Shows only visible elements by default, searches all when filtering
- **Consolidated Tool API**: Action-based tool schemas reduce tool count and improve usability
- **Nested Object Templates**: Message templates support dot notation for complex data structures

See the [GUIDE](./docs/GUIDE.md) for detailed feature documentation.
