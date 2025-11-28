# Command Replay

Record and replay command sequences for testing, automation, and debugging workflows.

> **Tip:** Use the `replay-agent` (`.claude/agents/replay-agent.md`) to build sequences through investigation - it records your tool calls automatically.

## Creating Sequences

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
// Save sequence to disk
replay({ action: 'save', sequenceId: 'seq-1234567890' })
// Saves to: .cdp-tools/sequences/<name>-<id>.json

// List saved sequences on disk
replay({ action: 'listSaved' })

// Load sequence from disk
replay({ action: 'load', filename: 'login-flow-123456.json' })

// Load into history (for editing)
replay({ action: 'load', filename: 'login-flow-123456.json', intoHistory: true })

// Delete saved file
replay({ action: 'deleteSaved', filename: 'login-flow-123456.json' })
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
// Record once
replay({ action: 'history' })
// ... perform test workflow ...
replay({
  action: 'create',
  name: 'checkout-test',
  description: 'Complete checkout flow with test product',
  expectedOutcome: 'Order confirmation page displayed',
  indices: [0, 1, 2, 3, 4]
})
replay({ action: 'save', sequenceId: 'seq-...' })

// Run anytime to verify
replay({ action: 'run', name: 'checkout-test' })
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
// Save common workflows as sequences
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
- **Persistence:** Sequences are kept in memory (cleared on restart); use save/load for disk persistence
- **Connection Stripping:** `connectionReason` is automatically removed when recording for portability
- **Element Validation:** After navigation/click, replay waits for the next element to exist
- **Debug-Aware:** Stale `callFrameId` values are automatically replaced with fresh ones during replay
