# Troubleshooting

## Chrome Connection Issues

### "Chrome is already running on port X"

**Solutions:**
- Use `killChrome({ reason: "restart needed" })` to stop existing instance
- Launch on different port: `launchChrome({ port: 9224, reference: 'new session' })`
- Check if another process is using the port: `lsof -i :9222`

### Chrome won't launch

**Solutions:**
- Check Chrome is installed in a standard location
- Verify no other Chrome debugging sessions are active
- Try `resetChromeLauncher({ reason: "stuck state" })` to reset launcher state

## Breakpoint Issues

### Breakpoint not hitting

**Problem:** Breakpoint set but never pauses

**Solutions:**
- Verify file URL matches exactly (use `searchCode` to find the right path)
- Check source maps are loading correctly
- Ensure code path is actually executed (add `console.log` to verify)
- Try setting logpoint first to confirm location is reachable

**Note:** Breakpoints survive rebuilds with cache-busting query params. If your bundler outputs `app.js?v=123` and rebuilds to `app.js?v=456`, existing breakpoints will automatically match the new script.

### Breakpoint shows as "pending"

**Problem:** Breakpoint status shows pending, not resolved

**Solutions:**
- The script may not be loaded yet - navigate to the page first
- Use `breakpoint({ action: 'waitForScript', url: '...' })` to wait for script to load
- Reload the page with `navigate({ action: 'reload' })`

### Wrong line number after setting breakpoint

**Problem:** CDP may map breakpoints to the nearest valid line

**Solutions:**
- Use `breakpoint({ action: 'validate', ... })` to check valid locations
- Set breakpoint on a line with executable code (not comments/whitespace)

## Element Issues

### Element not found

**Problem:** Selector doesn't match any elements

**Solutions:**
- Use `content({ action: 'findInteractive' })` to see available elements
- Check element is in viewport: might need to scroll first
- Wait for dynamic content: element may load asynchronously
- Try broader selector (class instead of ID)

### Cache not working

**Problem:** `findInteractive` shows "no cache" or stale data

**Solutions:**
- Cache expires after 5 minutes - navigate again to refresh
- Cache is page-specific - each URL has separate cache
- Clear navigation: `navigate({ action: 'goto', ... })` rebuilds cache

## Node.js Connection Issues

### Cannot connect to Node.js debugger

**Problem:** `connectDebugger` fails

**Solutions:**
- Ensure Node started with `--inspect` flag
- Check port number matches (default 9229)
- Verify Node process is still running
- Try `--inspect=0.0.0.0:9229` if connecting remotely

### Connection drops during debugging

**Solutions:**
- Check if Node process crashed (look at terminal output)
- Verify Node didn't restart (e.g., from nodemon)
- Reconnect with same reference: `connectDebugger({ reference: 'same ref', port: 9229 })`

### "Reference already in use" but no connection exists

**Problem:** Chrome was killed externally or tab was closed manually, but MCP still shows reference in use

**Solutions:**
- This is now auto-handled - stale connections are automatically detected and cleaned up
- Use `tab({ action: 'list' })` which validates and cleans up dead connections
- Use `listConnections()` which also cleans up stale references
- As fallback, use `killChrome({ reason: "cleanup" })` then relaunch

## Replay Issues

### Replay times out

**Problem:** Replay hangs or times out

**Solutions:**
- Increase step timeout: `stepTimeout: 60000` (60 seconds)
- Increase total timeout: `totalTimeout: 600000` (10 minutes)
- Check if page is waiting for user interaction (modal blocking?)

### Stale callFrameId error

**Problem:** `getVariables` fails with invalid call frame

**Solutions:**
- This should be auto-fixed - replay replaces stale IDs automatically
- If still failing, ensure debugger is actually paused
- Check breakpoint was hit with `inspect({ action: 'getCallStack' })`

### Variables not substituted

**Problem:** Replay uses original values instead of substituted ones

**Solutions:**
- Variable names are generated as `var_<index>_<selector>`
- Use `replay({ action: 'get', name: '...' })` to see variable names
- Pass empty `variables: {}` to keep original values explicitly

## Console/Network Monitoring

### Console messages not appearing

**Solutions:**
- Console monitoring starts automatically on connection
- Check message type filter: `console({ action: 'list', type: 'log' })`
- Clear and retry: `console({ action: 'clear', reason: 'reset' })`

### Network requests missing

**Solutions:**
- Enable monitoring first: `network({ action: 'enable' })`
- Monitoring must be enabled before requests are made
- Check resource type filter if used

## Source Map Issues

### Source maps not loading

**Solutions:**
- Source maps load lazily - they load when needed
- Check file size limits: inline (1MB), file (10MB)
- Manually load: `loadSourceMaps({ directory: './dist' })`

### Wrong file shown in call stack

**Solutions:**
- Verify source map is valid (check `.map` file exists and is valid JSON)
- Check `sourcesContent` is present in source map
- Try rebuilding with fresh source maps

## Server Management Issues

### Server won't start

**Problem:** `server({ action: 'start' })` fails

**Solutions:**
- Check working directory exists and is correct
- Verify the command works when run manually
- Check for port conflicts: `lsof -i :<port>`
- Check server logs: `server({ action: 'logs', serverId: '...' })`

### Docker server not detected

**Problem:** Docker container starts but port not detected

**Solutions:**
- Ensure port mapping is in the command: `-p 3000:3000`
- Runner may need explicit type: `runner: 'docker'`
- Check Docker is running: `docker ps`

### Port monitoring blocks all tools

**Problem:** Monitoring level is `block` and port went down

**Solutions:**
- Acknowledge the failure: `server({ action: 'acknowledgePort', port: <port> })`
- Check server status: `server({ action: 'list' })`
- Restart the server: `server({ action: 'restart', serverId: '...' })`

### Server logs not updating

**Solutions:**
- Logs are fetched incrementally (delta since last view)
- Use `lines: 100` to fetch all recent logs
- Clear logs: `server({ action: 'clearLogs', serverId: '...' })`

## General Tips

### Enable debug logging

```javascript
setDebugLogging({ enabled: true })
// Check logs at: .cdp-tools/logs/debug.log
```

### Check connection status

```javascript
// List all connections
listConnections()

// Check specific connection
getDebuggerStatus({ reference: 'my-session' })
```

### Check Chrome status

```javascript
getChromeStatus()
// Shows running instances, ports, and recent close events
```

### Reset everything

```javascript
// Kill all Chrome instances
killChrome({ reason: "full reset" })

// Reset launcher state
resetChromeLauncher({ reason: "stuck" })

// Start fresh
launchChrome({ reference: 'fresh start' })
```
