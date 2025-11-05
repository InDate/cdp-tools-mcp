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

**Debugging Approach**:
1. Set breakpoint in `handleFetchUser` function
2. Use `dispatchClick(selector: ".fetch-button")` to trigger (NOT clickElement!)
3. If breakpoint doesn't hit, selector is wrong
4. Use querySelector to find the correct selector

**Solution**: Fix typo in selector from `buttom` to `button`

**Note**: When debugging with breakpoints, always use `dispatchClick` instead of `clickElement` to avoid blocking!

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

### Challenge 9: Secret Vault Password (Logpoints Required) 🔐
**Symptom**: Need to find the password that unlocks the vault, but it's never logged completely
**Location**: `src/index.ts` - `constructVaultPassword()`, `getAccessModifier()`, and `unlockVault()` functions
**Challenge Type**: Logpoint demonstration (not a bug)

**The Problem**:
The vault password is constructed dynamically across multiple functions and iterations:
- Base password is built character-by-character from 6 security tokens
- Access level modifier is added based on user's access level
- The complete password is NEVER logged or stored in a single visible place
- Password format: Base (6 chars) + Modifier (varies by level)

**Why Logpoints Required**:
- Regular breakpoints would require stopping execution 6+ times in the loop
- Logpoints allow non-intrusive observation of password construction
- Can observe multiple executions with different access levels efficiently
- Demonstrates the power of logpoints for data collection

**Tools to Use**:
- `setLogpoint(url: "file:///path/to/dist/index.js", lineNumber: 150, logMessage: "Char: {char}, Password so far: {password}")`
  - Set inside `constructVaultPassword()` loop to observe character-by-character construction
- `setLogpoint(url: "file:///path/to/dist/index.js", lineNumber: 162, logMessage: "Modifier: {modifier}", condition: "level >= 2")`
  - Set in `getAccessModifier()` to see conditional modifier building
- `setLogpoint(url: "file:///path/to/dist/index.js", lineNumber: 184, logMessage: "Base: {basePassword}, Modifier: {modifier}")`
  - Set in `unlockVault()` to see final components before combination
- Use browser console to collect all logpoint outputs
- Try different access levels (1, 3, 5, 10) to see password variations

**Expected Passwords**:
- Access Level 1: `SPAbCD_L1`
- Access Level 3: `SPAbCD_L3`
- Access Level 5: `SPAbCD_L5_ADMIN`
- Access Level 10: `SPAbCD_L10_ADMIN`

**Learning Outcomes**:
1. When to use logpoints vs. breakpoints
2. How to set logpoints with expression interpolation
3. How to use conditional logpoints
4. Non-intrusive debugging for data collection
5. Observing iterative construction without pausing

**Solution**: Use logpoints at strategic locations to observe the password being constructed piece-by-piece, then reconstruct the complete password from console output

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
- [ ] Challenge 9: Used logpoints to discover vault password construction

## Success Criteria

All 9 challenges should be solvable using only the MCP debugger tools without:
- Reading the source code directly
- Using browser DevTools manually
- Guessing the solutions

The debugger should provide all necessary information to identify and understand each bug.
