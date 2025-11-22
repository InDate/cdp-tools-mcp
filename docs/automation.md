# Browser Automation

## Navigation

```javascript
// Navigate - automatically caches clickable elements
navigate({
  action: 'goto',
  url: 'https://myapp.com/login',
  connectionReason: 'test-session'
})
// Response: "144 total clickable elements (53 in viewport)"

// Reload page
navigate({ action: 'reload', connectionReason: 'test-session' })

// Go back/forward
navigate({ action: 'back', connectionReason: 'test-session' })
navigate({ action: 'forward', connectionReason: 'test-session' })

// Get page info
navigate({ action: 'info', connectionReason: 'test-session' })
```

## Finding Elements

```javascript
// Find clickable elements (from cache, viewport only by default)
content({
  action: 'findClickable',
  connectionReason: 'test-session'
})

// Search ALL cached elements
content({
  action: 'findClickable',
  search: 'login',
  connectionReason: 'test-session'
})

// Filter by type
content({
  action: 'findClickable',
  types: ['button', 'link'],
  connectionReason: 'test-session'
})

// Find input elements
content({
  action: 'findInput',
  search: 'email',
  connectionReason: 'test-session'
})
```

## Element Interaction

```javascript
// Click element
input({
  action: 'click',
  selector: '#login-button',
  connectionReason: 'test-session'
})

// Type text
input({
  action: 'type',
  selector: '#username',
  text: 'testuser@example.com',
  connectionReason: 'test-session'
})

// Press key
input({
  action: 'press',
  key: 'Enter',
  connectionReason: 'test-session'
})

// Hover
input({
  action: 'hover',
  selector: '.dropdown-menu',
  connectionReason: 'test-session'
})
```

## Modal Handling

Auto-dismiss modals during interactions:

```javascript
input({
  action: 'click',
  selector: '#submit',
  handleModals: true,
  dismissStrategy: 'auto',  // or 'accept', 'reject', 'close', 'remove'
  connectionReason: 'test-session'
})
```

**Strategies:**
- `auto`: Smart detection (cookies -> accept, GDPR -> accept, etc.)
- `accept`: Click accept/agree/ok buttons
- `reject`: Click reject/decline buttons
- `close`: Click X/close buttons
- `remove`: Remove modal from DOM

**Limitations:** English only, no Shadow DOM/iframe support

## DOM Inspection

```javascript
// Query selector
dom({
  action: 'querySelector',
  selector: '#main-content',
  connectionReason: 'test-session'
})

// Get element properties
dom({
  action: 'getProperties',
  selector: '#user-form',
  connectionReason: 'test-session'
})

// Get full DOM snapshot
dom({
  action: 'snapshot',
  maxDepth: 5,
  connectionReason: 'test-session'
})
```

## Screenshots

```javascript
// Full page screenshot
screenshot({
  action: 'fullPage',
  connectionReason: 'test-session'
})

// Viewport only
screenshot({
  action: 'viewport',
  connectionReason: 'test-session'
})

// Specific element
screenshot({
  action: 'element',
  selector: '#chart',
  connectionReason: 'test-session'
})

// PDF export
screenshot({
  action: 'pdf',
  connectionReason: 'test-session'
})
```

## Console Monitoring

```javascript
// List console messages
console({
  action: 'list',
  type: 'error',
  limit: 50,
  connectionReason: 'test-session'
})

// Get recent messages
console({
  action: 'recent',
  count: 20,
  connectionReason: 'test-session'
})

// Search console
console({
  action: 'search',
  pattern: 'API.*failed',
  connectionReason: 'test-session'
})

// Clear console
console({
  action: 'clear',
  reason: 'Starting fresh test',
  connectionReason: 'test-session'
})
```

## Network Monitoring

```javascript
// Enable monitoring
network({
  action: 'enable',
  connectionReason: 'test-session'
})

// List requests
network({
  action: 'list',
  resourceType: 'xhr',
  connectionReason: 'test-session'
})

// Search requests
network({
  action: 'search',
  pattern: '/api/users',
  connectionReason: 'test-session'
})

// Get specific request with body
network({
  action: 'get',
  id: 'request-123',
  includeBody: true,
  connectionReason: 'test-session'
})

// Set network conditions (throttling)
network({
  action: 'setConditions',
  preset: 'slow-3g',
  connectionReason: 'test-session'
})
```

## Storage

```javascript
// Get localStorage
storage({
  action: 'getLocalStorage',
  connectionReason: 'test-session'
})

// Set localStorage
storage({
  action: 'setLocalStorage',
  key: 'theme',
  value: 'dark',
  connectionReason: 'test-session'
})

// Get cookies
storage({
  action: 'getCookies',
  url: 'https://myapp.com',
  connectionReason: 'test-session'
})

// Set cookie
storage({
  action: 'setCookie',
  name: 'session',
  value: 'abc123',
  domain: 'myapp.com',
  connectionReason: 'test-session'
})

// Clear storage
storage({
  action: 'clear',
  types: ['localStorage', 'cookies'],
  reason: 'Reset test state',
  connectionReason: 'test-session'
})
```

## Tab Management

Manage multiple browser tabs:

```javascript
// Create a new tab
tab({
  action: 'create',
  reference: 'second tab',
  url: 'https://site2.com'
})

// List all tabs
tab({ action: 'list' })

// Switch between tabs
tab({
  action: 'switch',
  reference: 'second-tab'
})

// Rename a tab
tab({
  action: 'rename',
  reference: 'second-tab',
  newReference: 'checkout page'
})

// Close a tab
tab({
  action: 'close',
  reference: 'checkout-page'
})
```

## Automated Testing Pattern

1. **Navigate with element caching**
```javascript
navigate({ action: 'goto', url: 'https://myapp.com/signup', connectionReason: 'test-flow' })
```

2. **Find form elements from cache**
```javascript
content({ action: 'findInput', search: 'email', connectionReason: 'test-flow' })
```

3. **Fill form**
```javascript
input({ action: 'type', selector: '#email', text: 'test@example.com', connectionReason: 'test-flow' })
input({ action: 'type', selector: '#password', text: 'testpass123', connectionReason: 'test-flow' })
```

4. **Submit and monitor**
```javascript
input({ action: 'click', selector: '#submit-button', connectionReason: 'test-flow' })
console({ action: 'recent', count: 10, connectionReason: 'test-flow' })
network({ action: 'search', pattern: '/api/signup', connectionReason: 'test-flow' })
```

## Performance Investigation Pattern

1. **Enable network monitoring**
```javascript
network({ action: 'enable', connectionReason: 'perf-check' })
```

2. **Navigate and capture requests**
```javascript
navigate({ action: 'goto', url: 'http://localhost:3000', connectionReason: 'perf-check' })
```

3. **Find slow requests**
```javascript
network({ action: 'list', connectionReason: 'perf-check' })
// Look for long timing.duration values
```

4. **Set logpoints in suspect code**
```javascript
breakpoint({
  action: 'setLogpoint',
  url: 'http://localhost:3000/api-client.js',
  lineNumber: 75,
  logMessage: 'API call started at {Date.now()}',
  connectionReason: 'perf-check'
})
```
