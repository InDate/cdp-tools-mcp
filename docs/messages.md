# LLM-CDP Message Templates

This file contains all user-facing messages for the llm-cdp debugger. Messages use markdown formatting and support variable interpolation using `{{variable}}` syntax.

## Template Usage Status

Some templates are currently unused but kept for:
- Future error paths and edge cases
- Potential error conditions not yet encountered
- Consistency across similar tools
- Forward compatibility

**Currently unused templates (kept for future use):**
- BREAKPOINT_ALREADY_EXISTS - For duplicate breakpoint detection
- CHROME_LAUNCH_SUCCESS - For enhanced launch messages
- CONSOLE_MONITORING_ENABLED - For explicit monitoring activation
- DEBUGGER_CONNECT_SUCCESS - Reserved for verbose connection mode
- EXECUTION_CONTEXT_DESTROYED - For context destruction errors
- LINE_NOT_FOUND - For invalid line number errors
- LOGPOINT_SET_SUCCESS - For logpoint creation confirmation
- LOGPOINT_VALIDATE_SUCCESS - For logpoint validation feedback
- PLATFORM_UNSUPPORTED - For unsupported platform errors
- PORT_NOT_INSPECTABLE - For port availability errors
- SCRIPT_NOT_FOUND - For missing script errors
- SESSION_CLOSED - For session termination errors
- TIMEOUT_WAITING_FOR_PAUSE - For pause timeout errors

These templates should not be removed - they represent potential error conditions or future enhancements.

---

## Connection Messages

## CHROME_ALREADY_RUNNING

**Type:** error
**Code:** CHROME_RUNNING

Chrome is already running. You can either:

**Suggestions:**
- Use `killChrome()` to close the existing instance
- Use `connectDebugger()` to connect to the running instance instead

---

## CHROME_LAUNCH_SUCCESS

**Type:** success

Chrome launched and debugger connected on port {{port}}
Connection ID: {{connectionId}}, Runtime: {{runtimeType}}, PID: {{pid}}
Features: {{features}}

---

## CHROME_LAUNCH_NO_CONNECT

**Type:** success

Chrome launched with debugging on port {{port}}

---

## CHROME_LAUNCH_AUTO_CONNECT_FAILED

**Type:** warning

Chrome launched successfully but auto-connect failed: {{error}}

**Note:** Use `connectDebugger()` to connect manually.

---

## DEBUGGER_CONNECT_SUCCESS

**Type:** success

Connected to {{runtimeType}} debugger on {{host}}:{{port}}
Connection ID: {{connectionId}}
Features: {{features}}

---

## DEBUGGER_CONNECT_FAILED

**Type:** error
**Code:** CONNECTION_FAILED

Failed to connect to debugger at {{host}}:{{port}}: {{error}}

**Suggestions:**
- Verify the debugger is running and listening on the specified port
- For Chrome: Launch with `launchChrome()` or start with `--remote-debugging-port={{port}}`
- For Node.js: Start with `node --inspect={{port}} app.js`

---

## DEBUGGER_NOT_RUNNING

**Type:** error
**Code:** NOT_RUNNING

{{message}}

**Note:** This error occurs when trying to connect to a debugger that is not running on the specified port.

---

## DEBUGGER_NOT_CONNECTED

**Type:** error
**Code:** NOT_CONNECTED

Not connected to debugger

**Suggestions:**
- Use `launchChrome()` to launch Chrome with debugging enabled
- Use `connectDebugger()` to connect to an existing debugger instance

**Example:**
```javascript
// Launch Chrome
launchChrome({ url: 'http://localhost:3000' })

// Or connect to existing
connectDebugger({ host: 'localhost', port: 9222 })
```

---

## DEBUGGER_DISCONNECT_SUCCESS

**Type:** success

Disconnected from connection {{connectionId}}

---

## PORT_NOT_INSPECTABLE

**Type:** error
**Code:** PORT_NOT_READY

Chrome debugging port {{port}} failed to become inspectable within the timeout period

**Suggestions:**
- Chrome may be starting slowly - try increasing the timeout
- Check if another process is using port {{port}}
- Verify Chrome launched successfully (check process list)

---

## CHROME_KILLED

**Type:** success

Chrome process killed successfully

---

## CHROME_STATUS

**Type:** info

Chrome launcher status

---

## CHROME_LAUNCHER_RESET

**Type:** success

Chrome launcher state reset successfully

---

## CONNECTION_STATUS

**Type:** info

Connection status retrieved

---

## CONNECTIONS_LIST

**Type:** info

Active debugger connections ({{totalConnections}} total)

---

## CONNECTION_SWITCH_SUCCESS

**Type:** success

Switched to connection {{connectionId}}

---

## CONNECTION_SWITCH_FAILED

**Type:** error
**Code:** CONNECTION_NOT_FOUND

Connection {{connectionId}} not found

**Suggestion:** Use `listConnections()` to see all available connections.

---

## CONNECTION_NOT_FOUND

**Type:** error
**Code:** NO_CONNECTION

No active connection found

**Suggestions:**
- Use `launchChrome()` to launch Chrome with debugging enabled
- Use `connectDebugger()` to connect to an existing debugger instance

---

## SOURCE_MAPS_LOADED

**Type:** success

Loaded {{count}} source maps from {{directory}}

---

## SOURCE_MAPS_FAILED

**Type:** error
**Code:** SOURCE_MAP_ERROR

Failed to load source maps: {{error}}

**Suggestions:**
- Verify the directory path is correct
- Ensure .js.map files exist in the directory
- Check file permissions

---

## SOURCE_CODE_SUCCESS

**Type:** success

Source code retrieved from {{url}} (lines {{startLine}}-{{endLine}})

---

## SOURCE_CODE_FAILED

**Type:** error
**Code:** SOURCE_CODE_ERROR

Failed to retrieve source code: {{error}}

---

## CODE_SEARCH_RESULTS

**Type:** info

Code search completed - found {{count}} matches

---

## FUNCTION_SEARCH_RESULTS

**Type:** info

Function search completed - found {{count}} matches for '{{functionName}}'

---

## Breakpoint Messages

## BREAKPOINT_SET_SUCCESS

**Type:** success

Breakpoint set at {{url}}:{{lineNumber}} (ID: {{breakpointId}}){{#condition}}
Condition: {{condition}}{{/condition}}

---

## BREAKPOINT_SET_FAILED

**Type:** error
**Code:** BREAKPOINT_FAILED

Failed to set breakpoint at {{url}}:{{lineNumber}}: {{error}}

**Suggestions:**
- Verify the file URL is correct (use `file://` for local files or `http://` for web URLs)
- Ensure the line number exists in the source file
- Check that the debugger is paused or the script is already loaded

---

## BREAKPOINT_ALREADY_EXISTS

**Type:** error
**Code:** BREAKPOINT_EXISTS

A breakpoint already exists at {{url}}:{{lineNumber}}

**TIP:** Use `listBreakpoints()` to see all active breakpoints and their IDs.

---

## BREAKPOINT_REMOVE_SUCCESS

**Type:** success

Breakpoint {{breakpointId}} removed successfully

---

## BREAKPOINT_NOT_FOUND

**Type:** error
**Code:** BREAKPOINT_NOT_FOUND

Breakpoint {{breakpointId}} not found

**Suggestions:**
- Use `listBreakpoints()` to see all active breakpoints
- The breakpoint may have already been removed

---

## LOGPOINT_SET_SUCCESS

**Type:** success

Logpoint set at {{url}}:{{lineNumber}} (max executions: {{maxExecutions}})

**Breakpoint ID:** `{{breakpointId}}`
**Log message:** `{{logMessage}}`

**Note:** Logpoint will pause execution after {{maxExecutions}} executions. Use `resetLogpointCounter()` to reset the counter.

---

## LOGPOINT_VALIDATE_SUCCESS

**Type:** success

Logpoint validation successful! The expression can be evaluated at {{url}}:{{lineNumber}}

**Sample output:** {{sampleOutput}}

---

## LOGPOINT_VALIDATE_FAILED

**Type:** error
**Code:** LOGPOINT_INVALID

Logpoint validation failed: {{error}}

**Suggestions:**
- Check that the expressions in `{curly braces}` are valid JavaScript
- Ensure variables referenced exist in the scope at that line
- Try evaluating the expression manually with `evaluateExpression()`

---

## LOGPOINT_LIMIT_EXCEEDED

**Type:** warning
**Code:** LOGPOINT_LIMIT

Logpoint at {{url}}:{{lineNumber}} has reached execution limit ({{executionCount}}/{{maxExecutions}})

Captured logs:
{{logs}}

Options:
- Use resetLogpointCounter('{{breakpointId}}') to continue logging
- Use removeBreakpoint('{{breakpointId}}') to remove the logpoint
- Review the captured logs above

---

## LOGPOINT_COUNTER_RESET

**Type:** success

Logpoint {{breakpointId}} execution counter reset. It can now execute {{maxExecutions}} more times.

---

## Execution Messages

## EXECUTION_PAUSED

**Type:** success

Execution paused

---

## EXECUTION_RESUMED

**Type:** success

Execution resumed

---

## EXECUTION_STEP_OVER

**Type:** success

Stepped over to next line

---

## EXECUTION_STEP_INTO

**Type:** success

Stepped into function

---

## EXECUTION_STEP_OUT

**Type:** success

Stepped out of function

---

## CALL_STACK_SUCCESS

**Type:** success

Call Stack ({{frameCount}} frames){{#pausedLocation}} - Paused at: {{pausedLocation}}{{/pausedLocation}}

---

## VARIABLES_SUCCESS

**Type:** success

Variables for call frame {{callFrameId}}: {{totalCount}} total{{#filter}} (filtered by: {{filter}}){{/filter}}{{#includeGlobal}} (includes global scope){{/includeGlobal}}

---

## EVALUATE_EXPRESSION_SUCCESS

**Type:** success

Expression result: {{expression}}

---

## EVALUATE_EXPRESSION_FAILED

**Type:** error
**Code:** EVALUATION_FAILED

Failed to evaluate expression: {{error}}

**Expression:** `{{expression}}`

**Suggestions:**
- Check that the expression is valid JavaScript
- Ensure variables referenced exist in the current scope
- If evaluating in a specific frame, verify the call frame ID is valid with `getCallStack()`

---

## NOT_PAUSED

**Type:** error
**Code:** NOT_PAUSED

Not currently paused at a breakpoint

**Suggestions:**
- Use `pause()` to pause execution
- Set a breakpoint with `setBreakpoint()` and trigger it
- Wait for execution to hit an existing breakpoint

---

## TIMEOUT_WAITING_FOR_PAUSE

**Type:** error
**Code:** TIMEOUT

Timeout waiting for execution to pause

**Suggestions:**
- The breakpoint may not be hit in the code path being executed
- Try increasing the timeout duration
- Verify the breakpoint is set at the correct location with `listBreakpoints()`

---

## Browser Automation Messages

## PAGE_NAVIGATE_SUCCESS

**Type:** success

Navigated to {{url}}{{#title}}

Page title: {{title}}{{/title}}

---

## PAGE_GO_BACK_SUCCESS

**Type:** success

Navigated back{{#url}} to: {{url}}{{/url}}

---

## PAGE_GO_FORWARD_SUCCESS

**Type:** success

Navigated forward{{#url}} to: {{url}}{{/url}}

---

## PAGE_RELOAD_SUCCESS

**Type:** success

Page reloaded successfully

---

## ELEMENT_NOT_FOUND

**Type:** error
**Code:** ELEMENT_NOT_FOUND

Element not found: `{{selector}}`

**Suggestions:**
- Verify the CSS selector is correct
- Use `querySelector()` to test if the element exists
- The element may not be visible or loaded yet - try waiting or reloading the page

---

## ELEMENT_CLICK_SUCCESS

**Type:** success

Clicked element: `{{selector}}`

---

## TEXT_TYPE_SUCCESS

**Type:** success

Text typed into `{{selector}}`: "{{text}}"

---

## KEY_PRESS_SUCCESS

**Type:** success

Key pressed: `{{key}}`

---

## ELEMENT_HOVER_SUCCESS

**Type:** success

Hovered over element: `{{selector}}`

---

## ELEMENT_CLICK_WARNING

**Type:** warning

Element `{{selector}}` was clicked, but may not have a click handler attached. Verify the expected action occurred.

---

## SCREENSHOT_SAVED

**Type:** success

Screenshot saved to `{{filepath}}` ({{fileSize}})

---

## DOM_SNAPSHOT_SUCCESS

**Type:** success

DOM snapshot retrieved (depth: {{depth}})

---

## Monitoring Messages

## CONSOLE_MONITORING_ENABLED

**Type:** info

Console monitoring auto-enabled. Page auto-reloaded to capture initial logs.

---

## CONSOLE_CLEARED

**Type:** success

Console cleared successfully ({{count}} messages removed)

---

## CONSOLE_MESSAGES_LIST

**Type:** success

Console Messages: {{count}} of {{totalCount}} total{{#type}} (filtered by type: {{type}}){{/type}}

---

## CONSOLE_MESSAGE_DETAIL

**Type:** success

Console message [{{id}}] - Type: {{type}}, Timestamp: {{timestamp}}
Text: {{text}}

---

## CONSOLE_MESSAGES_RECENT

**Type:** success

Recent Console Messages: {{count}} of {{requestedCount}} requested ({{totalCount}} total){{#type}} (filtered by type: {{type}}){{/type}}

---

## CONSOLE_SEARCH_RESULTS

**Type:** success

Console Log Search: {{matchCount}} matches for pattern "{{pattern}}"{{#flags}} (flags: {{flags}}){{/flags}}{{#type}} (type: {{type}}){{/type}} out of {{totalSearched}} searched

---

## NETWORK_MONITORING_ENABLED

**Type:** success

Network monitoring enabled

---

## NETWORK_MONITORING_DISABLED

**Type:** success

Network monitoring disabled

---

## NETWORK_CONDITIONS_SET

**Type:** success

Network conditions set to **{{preset}}**

---

## NETWORK_REQUESTS_LIST

**Type:** success

Network Requests: {{count}} of {{totalCount}} total{{#resourceType}} (filtered by type: {{resourceType}}){{/resourceType}}

---

## NETWORK_REQUEST_DETAIL

**Type:** success

Network Request [{{id}}]: {{method}} {{url}}
Resource Type: {{resourceType}}, Status: {{status}}{{#failed}}
FAILED: {{errorText}}{{/failed}}

---

## NETWORK_SEARCH_RESULTS

**Type:** success

Network Request Search: {{matchCount}} matches for pattern "{{pattern}}"{{#flags}} (flags: {{flags}}){{/flags}}{{#filtersText}} (filters: {{filtersText}}){{/filtersText}} out of {{totalSearched}} searched

---

## NETWORK_REQUEST_NOT_FOUND

**Type:** error
**Code:** REQUEST_NOT_FOUND

Network request {{id}} not found

**Suggestions:**
- Use `listNetworkRequests()` to see all captured requests
- Ensure network monitoring was enabled before the request was made
- The request may have occurred before monitoring started

---

## Validation Errors

## SCRIPT_NOT_FOUND

**Type:** error
**Code:** SCRIPT_NOT_FOUND

Script not found for URL: {{url}}

**Suggestions:**
- Verify the URL is correct (use `file://` for local files)
- Ensure the script has been loaded by the browser
- For dynamically loaded scripts, wait for them to load before setting breakpoints
- Use `searchCode()` to find available scripts

---

## LINE_NOT_FOUND

**Type:** error
**Code:** LINE_NOT_FOUND

Line {{lineNumber}} not found in {{url}}

**Suggestions:**
- Verify the line number exists in the source file
- If using source maps, check that they're loaded correctly
- The file may have been modified - reload the page

---

## CALL_FRAME_NOT_FOUND

**Type:** error
**Code:** FRAME_NOT_FOUND

Call frame {{callFrameId}} not found

**Suggestions:**
- Use `getCallStack()` to get valid call frame IDs
- Ensure execution is still paused at a breakpoint
- The call stack may have changed if execution resumed

---

## System Errors

## PLATFORM_UNSUPPORTED

**Type:** error
**Code:** PLATFORM_UNSUPPORTED

Unsupported platform: {{platform}}

**Note:** Chrome launching is only supported on macOS, Windows, and Linux.

---

## CHROME_SPAWN_FAILED

**Type:** error
**Code:** SPAWN_FAILED

Failed to spawn Chrome process: {{error}}

**Suggestions:**
- Verify Chrome is installed on your system
- Check that you have permission to execute Chrome
- On macOS: Chrome should be at `/Applications/Google Chrome.app`
- On Linux: Chrome/Chromium should be in your PATH

---

## PUPPETEER_NOT_CONNECTED

**Type:** error
**Code:** PUPPETEER_NOT_CONNECTED

Not connected to browser. This operation requires browser automation support.

**Suggestions:**
1. Launch Chrome with `launchChrome()` (automatically enables browser automation)
2. Or connect to Chrome: `connectDebugger({ host: 'localhost', port: 9222 })`

**Note:** Browser automation features (DOM interaction, screenshots, navigation) are only available when connected to Chrome, not Node.js.

---

## PAGE_NOT_LOADED

**Type:** error
**Code:** PAGE_NOT_LOADED

No page loaded. The tool `{{toolName}}` requires a web page to be loaded first.

**Suggestions:**
1. Navigate to a URL with `navigateTo({ url: 'https://example.com' })`
2. Or launch Chrome with a URL: `launchChrome({ url: 'https://example.com' })`

**Note:** Chrome starts with a blank page by default. You must navigate to a URL before using tools that interact with page content.

---

## NODEJS_NOT_SUPPORTED

**Type:** error
**Code:** FEATURE_NOT_SUPPORTED

This feature is not supported for Node.js debugging ({{feature}})

**Available for Node.js:**
- Breakpoints and debugging
- Code execution and evaluation
- Call stack inspection
- Console log monitoring

**Not available for Node.js:**
- Browser automation (DOM, screenshots, navigation)
- Network request monitoring

**Suggestion:** Use `launchChrome()` if you need browser automation features.

---

## EXECUTION_CONTEXT_DESTROYED

**Type:** error
**Code:** CONTEXT_DESTROYED

Execution context was destroyed (page may have navigated or reloaded)

**Suggestions:**
- Reload the page and try again
- Reconnect to the debugger with `connectDebugger()`
- Check if the page navigated unexpectedly

---

## SESSION_CLOSED

**Type:** error
**Code:** SESSION_CLOSED

Debugger session closed unexpectedly

**Suggestions:**
- The browser or Node.js process may have crashed or been closed
- Use `getDebuggerStatus()` to check connection status
- Reconnect with `connectDebugger()` or relaunch with `launchChrome()`

---

## COOKIE_SET_SUCCESS

**Type:** success

Cookie set: `{{name}}`

---

## LOCAL_STORAGE_SET_SUCCESS

**Type:** success

localStorage item set: `{{key}}` = "{{value}}"

---

## STORAGE_CLEARED

**Type:** success

Storage cleared successfully ({{types}})

---

## Variable Templates

Common variables used across messages:

- `{{port}}` - Port number (e.g., 9222)
- `{{host}}` - Hostname (e.g., localhost)
- `{{url}}` - File or page URL
- `{{lineNumber}}` - Line number in source code
- `{{columnNumber}}` - Column number in source code (optional)
- `{{breakpointId}}` - Unique breakpoint identifier
- `{{connectionId}}` - Debugger connection identifier
- `{{runtimeType}}` - 'chrome' or 'node'
- `{{error}}` - Error message or details
- `{{selector}}` - CSS selector string
- `{{filepath}}` - File system path
- `{{fileSize}}` - Human-readable file size
- `{{id}}` - Generic identifier (request ID, log ID, etc.)
- `{{count}}` - Numeric count
- `{{logMessage}}` - Logpoint message template
- `{{maxExecutions}}` - Maximum execution count for logpoints
- `{{executionCount}}` - Current execution count
- `{{logs}}` - Formatted log output
- `{{feature}}` - Feature name
- `{{platform}}` - Operating system platform
- `{{types}}` - List of storage types
- `{{depth}}` - DOM traversal depth
- `{{sampleOutput}}` - Example output from validation
- `{{reference}}` - Tab reference name
- `{{newReference}}` - New tab reference name
- `{{closedReference}}` - Closed tab reference
- `{{newActiveReference}}` - New active tab reference
- `{{newActiveConnectionId}}` - New active connection ID
- `{{closedConnectionId}}` - Closed connection ID

---

## Tab Management Messages

## TAB_CREATE_SUCCESS

**Type:** success

Tab created successfully!

**Connection ID:** {{connectionId}}
**Reference:** {{reference}}
**URL:** {{url}}
**Title:** {{title}}

---

## TAB_CREATE_FAILED

**Type:** error
**Code:** TAB_CREATE_FAILED

Failed to create new tab: {{error}}

**Suggestions:**
- Ensure a Chrome browser is already running (use `launchChrome` first)
- Check that the browser connection is still active

---

## TAB_RENAME_SUCCESS

**Type:** success

Tab renamed successfully!

**Connection ID:** {{connectionId}}
**New Reference:** {{newReference}}

---

## TAB_SWITCH_SUCCESS

**Type:** success

Switched to tab: {{reference}}

**Connection ID:** {{connectionId}}
**URL:** {{url}}
**Title:** {{title}}

---

## TAB_CLOSE_SUCCESS

**Type:** success

Tab closed successfully!

**Closed Connection:** {{closedConnectionId}} ({{closedReference}})
**New Active Connection:** {{newActiveConnectionId}} ({{newActiveReference}})

---

## TAB_CLOSE_FAILED

**Type:** error
**Code:** TAB_CLOSE_FAILED

Failed to close tab: {{connectionId}}

**Suggestions:**
- Verify the connection ID is correct using `listTabs()`
- The tab may have already been closed
