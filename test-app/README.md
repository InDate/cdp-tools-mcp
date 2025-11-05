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
   Solve challenges by using the debug mcp tools launchChrome(port: 9222, url: "http://localhost:3000")
   ```

2. Connect the debugger:
   ```
   connectDebugger(port: 9222)
   ```

3. Start solving the challenges!

## Debug Challenges

### Challenge 1: DOM Manipulation Bug 🎯
**Symptom**: "Fetch User" button doesn't respond to clicks
**Location**: `public/client.js` - `setupEventListeners()` (line 10)
**Bug**: Selector has typo: `.fetch-buttom` instead of `.fetch-button`

**Tools to Use**:
- `querySelector(selector: ".fetch-button")`
- `querySelector(selector: ".fetch-buttom")`
- `getDOMSnapshot()` to see actual elements
- `getElementProperties(selector: "button")`
- `listConsoleLogs()` to see the error message

**Debugging Approach**:
1. Try clicking the "Fetch User" button - nothing happens
2. Check console logs for errors → see "ERROR: Fetch button not found!"
3. Use `querySelector('.fetch-button')` to verify the button exists in DOM
4. Look at the client.js code to find the typo in the event listener setup
5. Fix the typo by using `evaluateExpression` to manually attach the correct listener, or understand the bug

**Solution**: The event listener is looking for `.fetch-buttom` instead of `.fetch-button`

**Note**: Once you fix this (via console or by understanding it), the button will work and unlock Challenge 2!

---

### Challenge 2: Network Request Bug 🌐
**Symptom**: API returns 500 error even for valid requests
**Location**: `src/index.ts` - `/api/user/:id` endpoint
**Bug**: Server returns status 500 instead of 200 for successful requests

**Prerequisites**: Challenge 1 must be solved first so the button works!

**Tools to Use**:
- `enableNetworkMonitoring()` to capture requests
- Click the "Fetch User" button (now working after Challenge 1!)
- `listNetworkRequests()` or `searchNetworkRequests(pattern: "/api/user/.*")`
- `getNetworkRequest(id: "network-X")` to inspect details
- Set breakpoint in `handleFetchUser()` to inspect the response object
- Check `response.status` and `response.ok` values

**Debugging Approach**:
1. Enable network monitoring
2. Click "Fetch User" button
3. See request to `/api/user/1` returns status 500
4. Notice the UI still shows user data (bug!)
5. Set breakpoint in `handleFetchUser` function
6. Inspect `response` object → see `status: 500, ok: false`
7. Step through code → see it doesn't check `response.ok`

**Solution**: Client code doesn't check `response.ok` before processing JSON, so treats 500 errors as success

---

### Challenge 3 & 4: Console Errors & Variable Inspection 📋🐛
**Symptom**: Multiple error messages in console + array processing accesses undefined element
**Location**: `src/index.ts` - `/api/data` endpoint and `processItems()` function

**Challenge 3 - Console Error Tracking**:
**Tools to Use**:
- `searchConsoleLogs(pattern: "ERROR", flags: "i")`
- `listConsoleLogs(type: "error")`
- `getConsoleLog(id: "console-X")`

**Solution**: Use search to find all error messages and their locations

**Challenge 4 - Variable Inspection (Off-by-one)**:
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

### Challenge 5: localStorage Bug 💾
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

### Challenge 6: Performance Issue 🐌
**Symptom**: Slow network request taking over 3 seconds
**Location**: `src/index.ts` - `/api/slow` endpoint
**Bug**: Artificial delay of 3000ms

**Tools to Use**:
- `searchNetworkRequests(pattern: "/api/slow")`
- `listNetworkRequests()` and check duration
- Filter requests by duration > 2000ms

**Solution**: Find the slow endpoint and identify the setTimeout causing delay

---

### Challenge 7: Secret Vault Password (Logpoints Required) 🔐
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

- [ ] Challenge 1: Found DOM selector typo using querySelector and console logs
- [ ] Challenge 2: Found 500 status code in network requests using runtime debugging
- [ ] Challenge 3: Searched and found all ERROR messages in console
- [ ] Challenge 4: Set breakpoint, inspected variables, found off-by-one bug
- [ ] Challenge 5: Inspected localStorage and found key mismatch
- [ ] Challenge 6: Found slow request using network search
- [ ] Challenge 7: Used logpoints to discover vault password construction

## Success Criteria

All 7 challenges should be solvable using only the MCP debugger tools without:
- Reading the source code directly
- Using browser DevTools manually
- Guessing the solutions

The debugger should provide all necessary information to identify and understand each bug.

**Challenge Flow**: Challenges 1 and 2 are sequential - Challenge 1 (DOM bug) must be solved before Challenge 2 (network bug) can be properly tested, as they share the same button.
