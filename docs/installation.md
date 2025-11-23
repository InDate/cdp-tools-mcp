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
- **Manual override**: Set `MCP_DEBUG_PORT` environment variable
- **Valid range**: 1024-65535

### Environment Variables

```bash
# Set specific debug port
export MCP_DEBUG_PORT=9223
```

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
