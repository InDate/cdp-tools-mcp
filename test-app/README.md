# LLM-CDP Debugger Test Application

This is a test application with intentional bugs designed to validate the LLM-CDP debugger's capabilities.

## Setup

```bash
npm install
npm run build
npm run dev
```

The application will start on `http://localhost:3000` with debugging enabled on port `9229`.

## Using the Debugger

1. Launch Chrome with the MCP tool:
   ```
   launchChrome(port: 9222, url: "http://localhost:3000")
   ```

2. Connect the debugger:
   ```
   connectDebugger(port: 9222)
   ```

3. Start solving the challenges!

## Debug Challenges

### Challenge 1: Network Request Bug 🌐
**Symptom**: API returns 500 error even for valid requests
**Location**: `src/index.ts` - `/api/user/:id` endpoint
**Bug**: Server returns status 500 instead of 200 for successful requests

**Tools to Use**:
- `searchNetworkRequests(pattern: "/api/user/.*")`
- `getNetworkRequest(id: "network-X")`
- Inspect response status and body

**Solution**: Change `res.status(500)` to `res.status(200)` in line 27

---

### Challenge 2: Console Error Tracking 📋
**Symptom**: Multiple error messages scattered in console
**Location**: `src/index.ts` - `/api/data` endpoint
**Bug**: Console has ERROR messages that need to be found

**Tools to Use**:
- `searchConsoleLogs(pattern: "ERROR", flags: "i")`
- `listConsoleLogs(type: "error")`
- `getConsoleLog(id: "console-X")`

**Solution**: Use search to find all error messages and their locations

---

### Challenge 3: Variable Inspection Bug (Off-by-one) 🐛
**Symptom**: Array processing accesses undefined element
**Location**: `src/index.ts` - `processItems()` function (line 59)
**Bug**: Loop condition `i <= items.length` should be `i < items.length`

**Tools to Use**:
- `setBreakpoint(url: "file:///path/to/dist/index.js", lineNumber: 59)`
- `getCallStack()` when paused
- `getVariables(callFrameId: "frame-X")`
- `evaluateExpression(expression: "items.length")`
- `stepOver()` to see the bug happen

**Solution**: Change loop condition from `<=` to `<`

---

### Challenge 4: Async Race Condition ⚡
**Symptom**: Shared counter behaves unexpectedly with concurrent requests
**Location**: `src/index.ts` - `fetchDataWithDelay()` function
**Bug**: `sharedCounter` modified during async operation

**Tools to Use**:
- `setBreakpoint` at line 80 (before await)
- `setBreakpoint` at line 85 (after await)
- `getVariables` to inspect `localCounter` vs `sharedCounter`
- `evaluateExpression(expression: "sharedCounter")`
- Make multiple requests and step through to see the race

**Solution**: Each request should have isolated state, not shared counter

---

### Challenge 5: DOM Manipulation Bug 🎯
**Symptom**: "Fetch User" button doesn't respond to clicks
**Location**: `public/client.js` - `setupEventListeners()` (line 10)
**Bug**: Selector has typo: `.fetch-buttom` instead of `.fetch-button`

**Tools to Use**:
- `querySelector(selector: ".fetch-button")`
- `querySelector(selector: ".fetch-buttom")`
- `getDOMSnapshot()` to see actual elements
- `getElementProperties(selector: "button")`

**Solution**: Fix typo in selector from `buttom` to `button`

---

### Challenge 6: TypeScript Source Map Test 🗺️
**Symptom**: Need to debug TypeScript source, not compiled JavaScript
**Location**: Any function in `src/index.ts`
**Bug**: N/A - this tests source map functionality

**Tools to Use**:
- `loadSourceMaps(directory: "./dist")`
- `setBreakpoint(url: "file:///path/to/src/index.ts", lineNumber: X)`
- Verify breakpoint maps correctly to JavaScript

**Solution**: Confirm source maps work and breakpoints can be set in `.ts` files

---

### Challenge 7: localStorage Bug 💾
**Symptom**: Data stored but can't be retrieved
**Location**: `public/client.js` - `handleStorage()` (line 90)
**Bug**: Storing with key `usr_data` but retrieving with key `user_data`

**Tools to Use**:
- `getLocalStorage()` to see all keys
- `getLocalStorage(key: "usr_data")`
- `getLocalStorage(key: "user_data")`
- `setLocalStorage` to fix it

**Solution**: Use consistent key name for both storing and retrieving

---

### Challenge 8: Performance Issue 🐌
**Symptom**: Slow network request taking over 3 seconds
**Location**: `src/index.ts` - `/api/slow` endpoint
**Bug**: Artificial delay of 3000ms

**Tools to Use**:
- `searchNetworkRequests(pattern: "/api/slow")`
- `listNetworkRequests()` and check duration
- Filter requests by duration > 2000ms

**Solution**: Find the slow endpoint and identify the setTimeout causing delay

---

## Validation Checklist

- [ ] Challenge 1: Found 500 status code in network requests
- [ ] Challenge 2: Searched and found all ERROR messages
- [ ] Challenge 3: Set breakpoint, inspected variables, found off-by-one
- [ ] Challenge 4: Observed race condition with multiple requests
- [ ] Challenge 5: Found DOM selector typo using querySelector
- [ ] Challenge 6: Successfully used source maps with TypeScript
- [ ] Challenge 7: Inspected localStorage and found key mismatch
- [ ] Challenge 8: Found slow request using network search

## Success Criteria

All challenges should be solvable using only the MCP debugger tools without:
- Reading the source code directly
- Using browser DevTools manually
- Guessing the solutions

The debugger should provide all necessary information to identify and understand each bug.
