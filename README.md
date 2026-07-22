# cdp-tools-mcp

[![npm version](https://img.shields.io/npm/v/cdp-tools-mcp.svg)](https://www.npmjs.com/package/cdp-tools-mcp)
[![license](https://img.shields.io/npm/l/cdp-tools-mcp.svg)](https://github.com/InDate/cdp-tools-mcp/blob/main/LICENSE)

> Give AI agents real debugging superpowers—breakpoints, variable inspection, and browser automation through Chrome DevTools Protocol.

```bash
npx cdp-tools-mcp@latest
```

**Stop guessing, start debugging.** AI can read your code, but it can't see what happens when it runs. This MCP server changes that—giving your agent the same debugging tools you use in DevTools: set breakpoints, inspect variables mid-execution, watch network requests, and step through code line by line.

**Record once, replay forever.** Found a bug that requires 5 clicks to reproduce? Record the sequence once, then replay it instantly after every fix. No tokens wasted re-navigating, no "click the blue button" back-and-forth.

## Features

Your AI agent gets access to:
- 🐛 **Set breakpoints** and step through your code
- 🔍 **Inspect variables** and call stacks at runtime
- 📊 **Monitor console logs** and network requests
- 🌐 **Automate browser interactions** with smart element discovery
- 🔄 **Debug both Chrome and Node.js** applications simultaneously
- 🤖 **Multi-agent support**: Nested Claude agents can each manage their own browser tabs
- 🎯 **Targeted Server Management**: MCP that monitors ports and manages server processes automatically. If something fails, all tools are blocked until the LLM fixes the issue.
- 📋 **Issues Tracking**: Track bugs and features with recorded reproduction sequences that verify fixes automatically 

## Quick Start

**Claude Code:**
```bash
claude mcp add cdp-tools -- npx cdp-tools-mcp@latest
```

**Claude Desktop** — add to your config file:
```json
{
  "mcpServers": {
    "cdp-tools": {
      "command": "npx",
      "args": ["-y", "cdp-tools-mcp@latest"]
    }
  }
}
```

**Other MCP clients** — run `npx cdp-tools-mcp@latest` via stdio transport.

## Key Features

### Runtime Debugging
- **Breakpoint Management**: Set, remove, and list breakpoints (including conditional breakpoints and logpoints)
- **DOM/Event/XHR Breakpoints**: Pause on DOM mutations, event dispatches, or network requests
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
- **Interaction Recording**: Record mouse, keyboard, and navigation events with visual overlay
- **Test Export**: Export recordings as Playwright or Puppeteer tests

### Multi-Agent Support
- **Tab Management**: Nested Claude agents can each create and manage their own browser tabs within the same Chrome instance
- **Connection Management**: Debug Chrome and Node.js simultaneously with isolated connections
- **Port Handling**: Automatic port assignment prevents conflicts when running multiple sessions

### Server Management
- **Language-Agnostic**: Run any command - npm, flask, docker, or custom scripts
- **Docker Support**: Native support for Docker containers and Docker Compose stacks
- **Multi-Session Coordination**: Multiple MCP sessions share the same dev servers without port conflicts
- **Port Monitoring**: Detect server failures with configurable response levels (inform, error, block)
- **Persistent State**: Server PIDs, ports, and config survive session restarts
- **Auto-Restart**: Servers with autoRun enabled restart automatically with exponential backoff
- **Cross-Session Logs**: File-based logging lets any session read server output

### Issues Tracking
- **Bug & Feature Workflow**: Create issues, record reproduction steps, and verify fixes with automated replay
- **Sequence-Based Verification**: `workOn` navigates to context, `resolve` replays and confirms the fix

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

### Agent Skill

This package bundles an [Agent Skills](https://agentskills.io)-compatible skill at `skills/cdp-tools/` covering the same guidance as the Tool Instructions above, but split for progressive disclosure (name + description load at session start; the full workflow guide and tool catalog load only when a debugging task is underway). To enable it in a skills-aware client (e.g. Claude Code), symlink or copy it into a scanned skills directory:

```bash
mkdir -p .claude/skills
ln -s ../../node_modules/cdp-tools-mcp/skills/cdp-tools .claude/skills/cdp-tools
```

## Why cdp-tools-mcp?

**vs Chrome DevTools MCP:**
- ✅ **Breakpoint debugging** - Set breakpoints, step through code, inspect variables at runtime
- ✅ **Node.js debugging** - Debug backend applications, not just browsers
- ✅ **Multi-connection support** - Debug Chrome and Node.js simultaneously
- ✅ **Logpoints** - Add logging without modifying source code
- ✅ **Replay System** - Record and replay command sequences for testing and automation

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

### Latest
- **Issues Tracking**: New `issues` tool for bug/feature tracking with recorded reproduction sequences and automated verification
- **Recording Survives Navigation**: Overlay persists across page refresh with proper connection cleanup
- **Interaction Recording**: Record mouse clicks, drags, scrolls, keyboard input, and navigation events with a visual overlay - add comments during recording with Ctrl+Shift+C
- **Visual Replay Cursor**: See exactly where clicks happen during replay with animated cursor and ripple effects
- **Test Export**: Export recordings as Playwright (.spec.ts) or Puppeteer (.test.js) tests with `export({ name: "my-test", format: "playwright" })`
- **Config Management**: New `config` tool to manage settings - switch between local/global config, backup, reset, and view current configuration
- **Cross-Directory Server Access**: Use `global: true` flag to access servers started from a different working directory
- **DOM/Event/XHR Breakpoints**: Pause on DOM mutations (`setDOMBreakpoint`), event dispatches (`setEventBreakpoint`), or network requests (`setXHRBreakpoint`) using CDP's DOMDebugger domain
- **Replay Repeat Action**: Instantly re-execute commands from history with `replay({ action: 'repeat', indices: [0, 1, 2] })` - each tool response now shows its history index for easy repetition
- **UI Verification**: Detect dead buttons, broken links, small touch targets, and overflow issues with CDP-based verification - no heuristics, just facts
- **DOM Change Detection**: See exactly what changed after each click, type, or hover - no more guessing what a button did
- **Port Monitoring**: Detect server failures with `monitorPort` action - configurable levels (inform, error, block) affect tool responses when monitored ports go down
- **Docker Support**: Server management now supports Docker containers and Docker Compose stacks alongside native processes
- **Language-Agnostic Servers**: Generic command execution replaces npm-specific logic - run any command (flask, python, go, etc.)
- **Variable Inspection Fallbacks**: `getVariables` gracefully degrades when data exceeds token limits (full → depth reduced → names only → counts only)
- **Stale Connection Cleanup**: Auto-detects and removes dead connections when Chrome is killed externally or tabs are closed
- **Breakpoint Pause Detection**: Input actions now detect and report when they trigger breakpoints
- **Multi-Session Server Coordination**: Multiple MCP sessions share dev servers with persistent state, auto-restart, and cross-session log access
- **Webpack Eval Support**: Code search now extracts actual source from webpack eval wrappers
- **Lazy Source Map Loading**: On-demand loading improves startup performance
- **Cache-Busting Breakpoints**: Breakpoints survive rebuilds with changing query params
- **Flexible Connection References**: Lookups now tolerate minor formatting variations
- **Enhanced Replay System**: Record and replay command sequences for testing and automation
- **Conditional Commands**: Sequences can branch based on runtime conditions (selectors, URLs, cookies, localStorage) with configurable depth limits
- **Smart Element Caching**: Navigation automatically caches all clickable elements for instant discovery
- **Viewport-Aware Filtering**: Shows only visible elements by default, searches all when filtering
- **Consolidated Tool API**: Action-based tool schemas reduce tool count and improve usability
- **Debug Logging**: Track server operations with `setDebugLogging({ enabled: true })`

See the [docs](./docs/README.md) for detailed feature documentation.
