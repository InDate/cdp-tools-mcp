# UI Debugging with Replay Sequences

I'm an expert at using the cdp-tools replay system for UI bug detection and test automation. I'll guide you through building, managing, and executing replay sequences.

## Why I'm Using Replay Sequences

I'm dealing with a UI bug that's non-deterministic, context-dependent, or requires precise reproduction steps. Traditional approaches—manual testing, screenshot comparisons, or unit tests—aren't capturing the dynamic, stateful nature of what's happening in the browser.

The replay system treats **my interactions as first-class data**. Every tool call I make is automatically recorded, creating a time-ordered command history that captures exactly what happened. This history becomes the foundation for creating deterministic, replayable sequences that:

1. **Reproduce my bug reliably** - The sequence captures the exact steps that triggered it, eliminating "works on my machine" conversations
2. **Debug at any depth** - I can include breakpoints and variable inspection, not just UI interactions
3. **Adapt to changing code** - Variables let me reuse the same sequence with different test data
4. **Chain workflows conditionally** - Conditional sequences handle dynamic states like "am I logged in or not?"

---

## Building Sequences: The Complete Workflow

### Phase 1: Record the Interaction

Every tool call I make is automatically recorded. I just perform my workflow:

```javascript
// These are recorded automatically as I work
launchChrome({ reference: "debug-session" })
navigate({ action: 'goto', url: 'http://localhost:3000/login' })
input({ action: 'type', selector: '#email', text: 'test@example.com' })
input({ action: 'type', selector: '#password', text: 'password123' })
input({ action: 'click', selector: 'button:has-text("Login")' })
```

### Phase 2: Review History and Select Commands

```javascript
// View what I recorded
replay({ action: 'history', limit: 20 })

// Output shows indexed commands:
// 0. launchChrome - {"reference":"debug-session"}
// 1. navigate - {"action":"goto","url":"http://localhost:3000/login"}
// 2. input - {"action":"type","selector":"#email","text":"test@example.com"}
// ...
```

### Phase 3: Create the Sequence with Metadata

```javascript
replay({
  action: 'create',
  name: 'login-flow',
  description: 'Logs into the application with test credentials',
  expectedOutcome: 'User should be redirected to dashboard with welcome message',
  indices: [0, 1, 2, 3, 4]
})
```

**Key metadata fields I should include:**
- `name` - Human-readable identifier (used for loading/running)
- `description` - Documents what the sequence does
- `expectedOutcome` - Defines success criteria (invaluable for test assertions)
- `startUrl` - Auto-detected from first `navigate goto` or I can specify manually

### Phase 4: Save for Persistence

```javascript
// Save to disk
replay({ action: 'save', sequenceId: 'seq-1234567890' })
// Saved to: .cdp-tools/sequences/login-flow-123456.json
```

The JSON file is portable—I can share it with my team or version-control it.

### Phase 5: Run with Variable Substitution

```javascript
// Preview sequence and see available variables
replay({ action: 'get', name: 'login-flow' })

// Run with different credentials
replay({
  action: 'run',
  name: 'login-flow',
  variables: {
    'var_2__email': 'different@example.com',
    'var_3__password': 'differentpassword'
  }
})
```

---

## Conditional Sequences: Handling Dynamic State

I need branching logic in my replays because the application state varies between runs.

### The Problem I'm Facing

My test needs to work whether or not I'm already logged in:
- If I'm logged out -> perform login first
- If I'm logged in -> proceed directly to the test

Without conditionals, I'd need two separate sequences or manual intervention every time.

### The Solution: Conditional Commands

Conditional commands use handlebar syntax to evaluate the current page state:

```javascript
{
  tool: 'conditional',
  params: {
    if: '{{selector:.login-button}}',  // Condition to check
    then: 'auth-sequence'               // Sequence to run if true
  }
}
```

### Condition Types I Can Use

| Type | Syntax | True When |
|------|--------|-----------|
| Selector exists | `{{selector:.class}}` | Element found in DOM |
| Selector absent | `{{!selector:.class}}` | Element NOT found |
| URL contains | `{{url:contains:dashboard}}` | URL includes string |
| URL matches regex | `{{url:matches:^/admin}}` | URL matches pattern |
| Cookie exists | `{{cookie:session_token}}` | Cookie is set |
| Cookie absent | `{{!cookie:auth}}` | Cookie NOT set |
| localStorage exists | `{{localStorage:user_id}}` | Key exists |
| localStorage absent | `{{!localStorage:theme}}` | Key NOT present |

### Example: Making My Test Auth-Aware

**Step 1: I create an auth sequence**

```javascript
replay({
  action: 'create',
  name: 'perform-login',
  description: 'Logs in with test credentials',
  indices: [0, 1, 2, 3]  // navigate, type email, type password, click login
})
replay({ action: 'save', sequenceId: 'seq-...' })
```

**Step 2: I create my main sequence with a conditional**

I record my main test workflow, then add a conditional command at the start:

```javascript
// The sequence commands array would include:
[
  {
    tool: 'conditional',
    params: {
      if: '{{selector:.login-button}}',  // Check if login button visible
      then: 'perform-login'               // Run auth sequence if needed
    }
  },
  // ... rest of my test commands
]
```

**Step 3: What Happens When I Run It**

1. System evaluates `{{selector:.login-button}}`
2. If login button exists -> loads and executes `perform-login` sequence
3. After auth completes (or if I was already logged in) -> continues to my main test steps

### Safety Features I Get Automatically

- **Circular reference detection**: `A -> B -> A` is caught and errors out
- **Depth limiting**: Maximum 10 levels of nesting (configurable via `config.json`)
- **Regex validation**: URL match patterns are validated and length-limited
- **Error differentiation**: "Condition not met" vs "evaluation error" are distinct states

---

## Debug-Aware Sequences

Sequences aren't just for UI automation—I use them for **debugging workflows** too.

### Setting Breakpoints in My Sequences

```javascript
replay({
  action: 'create',
  name: 'debug-auth-handler',
  description: 'Sets breakpoint on auth callback and triggers OAuth flow',
  expectedOutcome: 'Debugger pauses at auth.js:42 showing token object',
  indices: [0, 1, 2, 3, 4, 5]  // launch, navigate, set breakpoint, trigger flow
})
```

### What Gets Handled Automatically

The replay system handles debugging complexities for me:

1. **Stale `callFrameId` replacement** - When replaying `getVariables`, the system fetches a fresh call stack and replaces my recorded IDs
2. **Wait for debugger pause** - After navigation with breakpoints set, replay waits for the debugger to actually pause
3. **Debug state reporting** - After replay, shows me current pause location, active breakpoints, and suggested next steps

### Example: A Debug Sequence I Might Create

```json
{
  "name": "debug-setupEventListeners-on-load",
  "description": "Debugs the setupEventListeners function that runs on page load",
  "expectedOutcome": "Debugger pauses at client.js:7, showing script-level variables",
  "commands": [
    { "tool": "launchChrome", "params": { "reference": "debug test" } },
    { "tool": "navigate", "params": { "action": "goto", "url": "http://localhost:3101" } },
    { "tool": "breakpoint", "params": { "action": "set", "url": ".../client.js", "lineNumber": 7 } },
    { "tool": "navigate", "params": { "action": "reload" } },
    { "tool": "inspect", "params": { "action": "getCallStack" } },
    { "tool": "inspect", "params": { "action": "getVariables", "callFrameId": "..." } }
  ]
}
```

---

## Problems I'm Running Into and How Replay Helps

### 1. Element Timing (My Tests Are Flaky)

**What's happening**: Elements don't exist immediately after navigation—my clicks fail randomly.

**How replay helps**: Automatic retry logic (5 attempts, 500ms delay) for click/type/hover actions, plus it pre-fetches the next element after navigation.

### 2. Modal Interruptions

**What's happening**: Cookie consent banners, popups, and dialogs are blocking my interactions.

**How replay helps**: I use `handleModals: true` on input actions with smart dismissal strategies (`auto`, `accept`, `reject`, `close`, `remove`).

### 3. Network Timing

**What's happening**: The page shows stale content while network requests are still in flight.

**How replay helps**: Navigation validation checks for error pages, blank pages, and connection errors before proceeding.

### 4. Server Availability

**What's happening**: My localhost URLs fail because I forgot to start the server.

**How replay helps**: Port availability check before navigation to localhost URLs—fails fast with a helpful error message instead of hanging.

### 5. Timeout Management

**What's happening**: Operations hang indefinitely and I have to kill Chrome manually.

**How replay helps**: Dual timeout system—per-step (30s default) and total execution (5min default), both configurable.

---

## Step-Through Debugging of Sequences

For complex debugging, I can pause and step through sequences:

```javascript
// Pause at step 5
replay({ action: 'run', name: 'my-sequence', stepTo: 5 })

// Execute one more step
replay({ action: 'step', stepCount: 1 })

// Check status
replay({ action: 'status' })

// Finish remaining steps
replay({ action: 'finish' })

// Or abandon
replay({ action: 'cancel' })
```

I can even **insert new commands** while paused:

```javascript
// View recent history (commands executed since pause)
replay({ action: 'history' })

// Insert commands after current step
replay({ action: 'insert', insertIndices: [15, 16], insertAfterStep: 3, overwrite: true })
```

---

## Quick Reference

### Creating Sequences
```javascript
replay({ action: 'history', limit: 20 })           // View my recorded commands
replay({ action: 'create', name: '...', indices: [...] })  // Create sequence
replay({ action: 'save', sequenceId: '...' })      // Save to disk
```

### Running Sequences
```javascript
replay({ action: 'run', name: '...' })             // Run by name (loads from disk)
replay({ action: 'run', name: '...', variables: {...} })  // With variable substitution
replay({ action: 'run', name: '...', stepTo: 5 })  // Pause at step 5
```

### Managing Sequences
```javascript
replay({ action: 'list' })                         // List in-memory sequences
replay({ action: 'listSaved' })                    // List saved to disk
replay({ action: 'get', name: '...' })             // Preview sequence details
replay({ action: 'load', filename: '...' })        // Load from disk
replay({ action: 'delete', sequenceId: '...' })    // Delete from memory
replay({ action: 'deleteSaved', filename: '...' }) // Delete from disk
```

### Step-Through Control
```javascript
replay({ action: 'status' })                       // Check paused state
replay({ action: 'step', stepCount: 1 })           // Execute N steps
replay({ action: 'finish' })                       // Complete remaining
replay({ action: 'cancel' })                       // Abandon sequence
replay({ action: 'insert', insertIndices: [...] }) // Insert commands
```

---

## What I Need Help With

I may be trying to:
- Create a new sequence from my current workflow
- Debug why a sequence isn't working
- Add conditional logic to handle authentication or other dynamic states
- Convert manual test steps into a replayable sequence
- Troubleshoot flaky tests or timeout issues

Help me understand the "why" behind recommendations so I can build better sequences independently.
