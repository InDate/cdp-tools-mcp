# Command Replay

Record and replay command sequences for testing, automation, and debugging workflows.

> **Tip:** Use the `replay-agent` (`.claude/agents/replay-agent.md`) to build sequences through investigation - it records your tool calls automatically.

## Recording Interactions

The easiest way to create sequences is by recording your interactions directly in the browser.

### Start Recording

```javascript
// Launch Chrome with a meaningful name (becomes the sequence name)
launchChrome({ reference: "my signup test" })

// Start recording
replay({ action: 'recordInteraction', connectionReason: 'my-signup-test' })
```

A visual overlay appears showing:
- Recording status (REC/PAUSED)
- Event count and duration
- Coordinates and element info
- Buttons: 💬 Comment | ⏸ Pause | ↺ Reset | ✓ Complete

### Add Comments

During recording, add comments to document expected behavior:
- Click the 💬 button in the overlay
- Or press **Ctrl+Shift+C** (Cmd+Shift+C on Mac)
- Type your comment and save

Comments are attached to the previous action and appear in exported tests.

### Stop Recording

```javascript
replay({ action: 'stopInteraction', connectionReason: 'my-signup-test' })
```

This creates a sequence named after your connectionReason (e.g., "my-signup-test").

If a sequence with that name already exists, you'll be prompted to:
- Use a different name: `stopInteraction({ ..., name: "new-name" })`
- Overwrite: `stopInteraction({ ..., overwrite: true })`

## Exporting Tests

Export sequences as Playwright or Puppeteer tests:

```javascript
// Export as Playwright test
replay({ action: 'export', name: 'my-signup-test', format: 'playwright' })
// Creates: tests/e2e/my-signup-test.spec.ts
// Also saves: .cdp-tools/sequences/my-signup-test.json

// Export as Puppeteer test
replay({ action: 'export', name: 'my-signup-test', format: 'puppeteer' })
// Creates: tests/puppeteer/my-signup-test.test.js

// Export sequence JSON only
replay({ action: 'export', name: 'my-signup-test', format: 'sequence' })
// Creates: .cdp-tools/sequences/my-signup-test.json
```

### Configure Export Paths

In `.cdp-tools/config.json`:

```json
{
  "replay": {
    "playwrightExportPath": "./tests/e2e",
    "puppeteerExportPath": "./tests/puppeteer"
  }
}
```

### Preview Before Export

```javascript
// Preview as Playwright code
replay({ action: 'get', name: 'my-signup-test', outputFormat: 'playwright' })

// Preview as Puppeteer code
replay({ action: 'get', name: 'my-signup-test', outputFormat: 'puppeteer' })
```

## Visual Replay Cursor

When replaying sequences, a visual cursor shows exactly where clicks happen:

- **Animated cursor** moves to click position before clicking
- **Green ripple** on left clicks
- **Red ripple** on right clicks
- **Key press toast** shows keyboard input

Configure in `.cdp-tools/config.json`:

```json
{
  "replay": {
    "showCursor": true
  }
}
```

## Creating Sequences from History

### From Command History

```javascript
// View command history
replay({ action: 'history', limit: 20 })

// Create sequence from history indices
replay({
  action: 'create',
  name: 'login-flow',
  indices: [1, 2, 3, 4, 5]
})
```

### With Metadata

Add description and expected outcome for better documentation:

```javascript
replay({
  action: 'create',
  name: 'login-flow',
  description: 'Logs into the application with test credentials',
  expectedOutcome: 'User should be redirected to dashboard with welcome message',
  indices: [1, 2, 3, 4, 5]
})
```

The `description` and `expectedOutcome` fields are saved to disk and displayed when listing sequences.

## Managing Sequences

```javascript
// List all in-memory sequences
replay({ action: 'list' })

// View sequence details (by sequenceId or name)
replay({ action: 'get', sequenceId: 'seq-1234567890' })
replay({ action: 'get', name: 'login-flow' })  // loads from disk

// Delete a sequence from memory
replay({ action: 'delete', sequenceId: 'seq-1234567890' })
```

## Saving and Loading

```javascript
// Export sequence to disk (working directory)
replay({ action: 'export', sequenceId: 'seq-1234567890', format: 'sequence' })
// Saves to: .cdp-tools/sequences/<name>.json

// Export to global location (accessible from any directory)
replay({ action: 'export', sequenceId: 'seq-1234567890', format: 'sequence', global: true })
// Saves to: ~/.cdp-tools/sequences/<name>.json

// List saved sequences on disk
replay({ action: 'listSaved' })

// Load sequence from disk
replay({ action: 'load', filename: 'login-flow.json' })

// Load into history (for editing)
replay({ action: 'load', filename: 'login-flow.json', intoHistory: true })

// Delete saved file
replay({ action: 'deleteSaved', filename: 'login-flow.json' })
```

## Running Sequences

### Basic Run

```javascript
// Run with connection
replay({
  action: 'run',
  sequenceId: 'seq-1234567890',
  connectionReason: 'test-session'
})
```

### Preview Sequence

Use `get` action to preview a sequence before running:

```javascript
replay({ action: 'get', name: 'login-flow' })
// Shows: commands, variables, metadata, and run instructions
```

### Variable Substitution

Replace text inputs with new values during replay:

```javascript
// Original recording had: input({ action: 'type', text: 'original@email.com' })
replay({
  action: 'run',
  sequenceId: 'seq-login-flow',
  connectionReason: 'test-session',
  variables: {
    'var_2_#email': 'new@email.com',
    'var_3_#password': 'newpassword'
  }
})
```

### Timeout Configuration

Control execution timing for slow pages:

```javascript
replay({
  action: 'run',
  sequenceId: 'seq-slow-flow',
  connectionReason: 'test-session',
  stepTimeout: 60000,    // 60s per step (default: 30s)
  totalTimeout: 600000   // 10min total (default: 5min)
})
```

### Start From a Specific Step

Skip early steps and begin from a specific step number (useful for resuming or debugging):

```javascript
replay({
  action: 'run',
  name: 'login-flow',
  connectionReason: 'test-session',
  startFrom: 5  // Skip steps 1-4, start at step 5
})
```

### Auto-Launch Chrome

If the sequence starts with `launchChrome`, no connection is needed:

```javascript
replay({
  action: 'run',
  sequenceId: 'seq-my-flow'
  // connectionReason not required - uses reference from launchChrome
})
```

## Debug-Aware Replay

Replay automatically handles debugging sequences.

### Fresh callFrameId Replacement

When replaying `getVariables` with a recorded `callFrameId`, replay automatically fetches the current call stack and replaces the stale ID with a fresh one from the live session.

### Wait for Debugger Pause

After navigation commands (goto/reload), if breakpoints exist, replay waits for the debugger to pause before continuing. This ensures `getCallStack` and `getVariables` work correctly.

### Debug State Output

After successful replay, if breakpoints are active or execution is paused, replay shows the current debug state:

```
## Debug State

⏸️ **Execution paused** at http://localhost:3101/client.js:6

**Next steps:**
- Inspect call stack: `inspect({ action: 'getCallStack', connectionReason: '...' })`
- Get variables: `inspect({ action: 'getVariables', connectionReason: '...', callFrameId: '<from call stack>' })`
- Resume execution: `execution({ action: 'resume', connectionReason: '...' })`
- Step over: `execution({ action: 'stepOver', connectionReason: '...' })`

🔴 **1 active breakpoint**
- List breakpoints: `breakpoint({ action: 'list', connectionReason: '...' })`
```

## Click Validation

Click actions in replay sequences automatically validate their effects. When validation fails, the sequence pauses for inspection rather than failing outright.

### What Gets Validated

- **Console errors**: New errors after click (default: enabled)
- **Navigation**: URL change success (default: enabled)
- **DOM mutations**: Checks if click caused DOM changes (default: disabled)
- **Network requests**: Checks for failed network requests (default: disabled)

### Pause on Failure

When validation fails, you can:
- Inspect the error state
- Retry the step: `replay({ action: 'step', stepCount: 1 })`
- Skip and continue: `replay({ action: 'step', stepCount: 1 })`
- Cancel the sequence: `replay({ action: 'cancel' })`

### Configuration

Configure in `.cdp-tools/config.json`:

```json
{
  "clickValidation": {
    "enabled": true,
    "validateNavigation": true,
    "requireDomChanges": false,
    "domChangesFailMode": "warn",
    "failOnConsoleErrors": true,
    "consoleErrorsFailMode": "error",
    "validateNetworkPayload": false,
    "networkFailMode": "warn",
    "postClickDelayMs": 100
  }
}
```

**Fail modes:**
- `error`: Pauses the sequence for inspection
- `warn`: Logs a warning and continues

## Use Cases

### Regression Testing

```javascript
// Record interactions directly
launchChrome({ reference: "checkout test" })
replay({ action: 'recordInteraction', connectionReason: 'checkout-test' })
// ... perform test workflow in browser, click ✓ when done ...
replay({ action: 'stopInteraction', connectionReason: 'checkout-test' })

// Export as Playwright test
replay({ action: 'export', name: 'checkout-test', format: 'playwright' })

// Run anytime to verify
replay({ action: 'run', name: 'checkout-test', connectionReason: 'test-run' })
```

### Debugging Workflows

```javascript
// Create a debug sequence
replay({
  action: 'create',
  name: 'debug-auth-bug',
  description: 'Sets breakpoint on auth handler and triggers login',
  expectedOutcome: 'Debugger pauses at auth.js:42 showing user object',
  indices: [0, 1, 2, 3, 4, 5]
})

// Run to debug
replay({ action: 'run', name: 'debug-auth-bug' })
// Debug state shown automatically after run
```

### Automation

```javascript
// Record common workflows as sequences
replay({
  action: 'create',
  name: 'daily-smoke-test',
  description: 'Navigates key pages and checks for console errors',
  expectedOutcome: 'All pages load without errors',
  indices: [0, 1, 2, 3, 4, 5, 6, 7]
})

// Run anytime
replay({ action: 'run', name: 'daily-smoke-test' })
```

## Notes

- **Recording:** Only tool calls are recorded, not responses
- **Replay:** Commands execute sequentially in recorded order
- **Dry Run:** Preview execution without actually running commands
- **Persistence:** Sequences are kept in memory (cleared on restart); use export/load for disk persistence
- **Connection Stripping:** `connectionReason` is automatically removed when recording for portability
- **Element Validation:** After navigation/click, replay waits for the next element to exist
- **Debug-Aware:** Stale `callFrameId` values are automatically replaced with fresh ones during replay
