# Installation

## Claude Code CLI

```bash
claude mcp add cdp-tools -- npx -y cdp-tools-mcp
```

## Claude Desktop

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

## From Source

```bash
git clone https://github.com/InDate/cdp-tools-mcp.git
cd cdp-tools-mcp
npm install
npm run build
npm start
```

## Configuration

### Multi-Session Support

Each MCP server instance automatically uses a unique debugging port to prevent conflicts when running multiple LLM sessions simultaneously.

**Port Configuration:**
- **Auto-assigned**: Ports auto-assigned starting from 9222
- **Manual override**: Set `MCP_DEBUG_PORT` environment variable or configure in config file
- **Valid range**: 1024-65535

### Environment Variables

```bash
# Set specific debug port
export MCP_DEBUG_PORT=9223
```

### Config File

Create `.cdp-tools/config.json` to customize settings:

```json
{
  "chrome": {
    "defaultDebugPort": 9222
  }
}
```

The `defaultDebugPort` sets the starting port for Chrome debugging. If the port is in use, the next available port is used automatically.

### Idle Sessions

An editor window left open for days keeps its cdp-tools server alive, holding
Chrome instances, dev servers and monitor buffers nobody is using. Two things
stop that:

- **Idle suspend.** After two hours with no request from the client, the server
  releases what it privately holds - connections, the Chrome instances it
  launched, monitor buffers - and exits. The supervisor stays connected, so the
  MCP connection itself survives: the next tool call starts a fresh server. You
  will need to relaunch Chrome (`launchChrome`). Managed dev servers keep
  running and are reattached to, because they are shared between sessions on a
  project and stopping them could pull one out from under another window.
- **Orphan reaping.** When the client that launched cdp-tools is gone, the
  server tree shuts itself down, rather than waiting for a stdin EOF that never
  arrives when an `npm exec` wrapper is holding the pipe open.

```json
{
  "session": {
    "idleSuspendMinutes": 120,
    "clientPollSeconds": 60
  }
}
```

Set `idleSuspendMinutes` to `0` to never suspend. Both values can also be set
via `CDP_TOOLS_IDLE_SUSPEND_MINUTES` and `CDP_TOOLS_CLIENT_POLL_SECONDS`, which
take precedence over the config file. Unlike most settings these are read by the
supervisor at startup, so a change takes effect on the next reconnect rather
than hot-reloading.

### Debug Logging

Enable debug logging to track server operations:

```javascript
// Enable debug logging
setDebugLogging({ enabled: true })

// Check status
getDebugLoggingStatus()
// Logs written to: .cdp-tools/logs/debug.log
```

### Password Popup Prevention

Chrome is automatically configured to prevent password-related popups that can block automation:

- Password save prompts disabled
- Password leak detection disabled
- Mock keychain used on macOS

No configuration needed - this is enabled by default.
