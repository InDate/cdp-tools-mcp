# Command Replay

Record and replay command sequences for testing, automation, and debugging workflows.

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

// View sequence details
replay({ action: 'get', sequenceId: 'seq-1234567890' })

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

## Replaying Sequences

### Basic Replay

```javascript
// Replay with connection
replay({
  action: 'replay',
  sequenceId: 'seq-1234567890',
  connectionReason: 'test-session'
})
```

### Preview (Dry Run)

```javascript
replay({
  action: 'replay',
  sequenceId: 'seq-1234567890',
  dryRun: true
})
```

### Variable Substitution

Replace text inputs with new values during replay:

```javascript
// Original recording had: input({ action: 'type', text: 'original@email.com' })
replay({
  action: 'replay',
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
  action: 'replay',
  sequenceId: 'seq-slow-flow',
  connectionReason: 'test-session',
  stepTimeout: 60000,    // 60s per step (default: 30s)
  totalTimeout: 600000   // 10min total (default: 5min)
})
```

### Auto-Launch Chrome

If the sequence starts with `launchChrome`, no connection is needed:

```javascript
replay({
  action: 'replay',
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

// Replay anytime to verify
replay({ action: 'load', filename: 'checkout-test-123456.json' })
replay({ action: 'replay', sequenceId: 'seq-...', connectionReason: 'test' })
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

// Replay to debug
replay({ action: 'replay', sequenceId: 'seq-...' })
// Debug state shown automatically after replay
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
replay({ action: 'replay', sequenceId: 'seq-daily-smoke-test' })
```

## Notes

- **Recording:** Only tool calls are recorded, not responses
- **Replay:** Commands execute sequentially in recorded order
- **Dry Run:** Preview execution without actually running commands
- **Persistence:** Sequences are kept in memory (cleared on restart); use save/load for disk persistence
- **Connection Stripping:** `connectionReason` is automatically removed when recording for portability
- **Element Validation:** After navigation/click, replay waits for the next element to exist
- **Debug-Aware:** Stale `callFrameId` values are automatically replaced with fresh ones during replay
