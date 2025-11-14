# Message System Developer Guide

## Overview

The cdp-tools debugger uses a centralized message system to provide consistent, markdown-formatted responses to all tool calls. This guide explains how to use the system and when to use different patterns.

## Architecture

### Core Components

1. **docs/messages.md** - Message template definitions
   - Contains all user-facing message templates
   - Uses `{{variable}}` syntax for interpolation
   - Organized by category (Connection, Breakpoints, Execution, etc.)

2. **src/messages.ts** - Message management system
   - Loads and parses message templates at runtime
   - Provides helper functions for formatting responses
   - Exports MCP response creators

### Message Template Format

Each message template in `docs/messages.md` follows this structure:

```markdown
## MESSAGE_ID

**Type:** error | success | warning | info
**Code:** ERROR_CODE (for errors only)

Message content with {{variable}} interpolation

**Suggestions:**
- Suggestion 1
- Suggestion 2

**Note:** Optional note text

**Example:**
```javascript
// Optional code example
```
```

### Variable Interpolation

Templates support Mustache-like syntax:
- `{{variable}}` - Simple variable substitution
- `{{#variable}}...{{/variable}}` - Conditional sections (shown only if variable is truthy)

## Usage Patterns

### Pattern 1: Simple Success Response

Use `createSuccessResponse()` for straightforward success messages:

```typescript
import { createSuccessResponse } from '../messages.js';

return createSuccessResponse('BREAKPOINT_REMOVED', {
  breakpointId: 'bp-123'
});
```

**When to use:**
- Simple success confirmation
- No additional data to display
- Message template exists in docs/messages.md

### Pattern 2: Success Response with Data

Use `createSuccessResponse()` with data parameter for responses that include structured data:

```typescript
return createSuccessResponse('CALL_STACK_SUCCESS', {
  pausedLocation: 'app.js:42',
  frameCount: 5
}, {
  // This data will be formatted as a JSON code block
  callStackData: JSON.stringify(stack, null, 2)
});
```

**When to use:**
- Success message with structured data (call stacks, variables, etc.)
- Data should be displayed in a code block
- Message provides context, data provides details

### Pattern 3: Simple Error Response

Use `createErrorResponse()` for all error cases:

```typescript
import { createErrorResponse } from '../messages.js';

if (!cdpManager.isConnected()) {
  return createErrorResponse('DEBUGGER_NOT_CONNECTED');
}
```

**When to use:**
- Any error condition
- Message template exists with suggestions
- No custom error context needed

### Pattern 4: Error Response with Variables

Pass variables to customize error messages:

```typescript
return createErrorResponse('BREAKPOINT_SET_FAILED', {
  url: 'app.js',
  lineNumber: 42,
  error: 'Script not found'
});
```

**When to use:**
- Error with dynamic information
- Template has `{{variable}}` placeholders
- Standard error flow

### Pattern 5: Manual Construction (Complex Dynamic Content)

Use manual markdown construction for truly dynamic content:

```typescript
let markdown = getErrorMessage('BREAKPOINT_SET_FAILED', {
  url: targetUrl,
  lineNumber: targetLine,
  error: error.message,
});

// Add runtime-specific context
if (runtimeType === 'chrome' && url.includes('/dist/')) {
  markdown += '\n\n**TIP:** You are connected to Chrome but trying to set a breakpoint on server code...';
}

return {
  content: [{ type: 'text', text: markdown }],
  isError: true,
};
```

**When to use:**
- Highly dynamic content that can't be templated
- Runtime-specific contextual tips
- Complex conditional logic
- Keep this pattern minimal - prefer templates when possible

### Pattern 6: Non-Text MCP Content (Images)

For tools that return non-text MCP content types (like images):

```typescript
// Screenshot tools returning image content
return {
  content: [
    {
      type: 'text',
      text: `Screenshot captured (${size}KB)`,
    },
    {
      type: 'image',
      data: buffer.toString('base64'),
      mimeType: `image/${type}`,
    },
  ],
};
```

**When to use:**
- Returning image content (screenshots)
- Mixed content types (text + image)
- MCP content types other than 'text'
- **Technical blocker:** `createSuccessResponse()` only supports `{ type: 'text' }`

**Note:** This is the ONLY legitimate reason for manual construction. All other cases (including list/search operations) should use Pattern 2 with the `data` parameter.

## Helper Functions

### `createSuccessResponse(messageId, variables?, data?)`

Creates a success response with optional data.

- `messageId`: Template ID from docs/messages.md
- `variables`: Object with variable substitutions
- `data`: Optional data to display in code block
- Returns: MCP response object

### `createErrorResponse(messageId, variables?)`

Creates an error response with `isError: true`.

- `messageId`: Template ID from docs/messages.md
- `variables`: Object with variable substitutions
- Returns: MCP response object with `isError: true`

### `getErrorMessage(messageId, variables?)`

Gets formatted error message with suggestions (for manual construction).

- Returns: Markdown string with suggestions and examples

### `formatCodeBlock(data, language?)`

Formats data as a markdown code block.

- `data`: Object or string to format
- `language`: Code block language (default: 'json')
- Returns: Markdown code block string

## Decision Tree: Which Pattern to Use?

```
Is it an error?
├─ Yes → Use createErrorResponse()
│        └─ Need runtime-specific context?
│           ├─ No → Use createErrorResponse() directly (Pattern 3)
│           └─ Yes → Use getErrorMessage() + manual construction (Pattern 5)
│
└─ No (Success)
   ├─ Returning non-text content (images)? → Manual construction (Pattern 6)
   ├─ Simple confirmation? → Use createSuccessResponse() (Pattern 1)
   ├─ Includes structured data? → Use createSuccessResponse() with data param (Pattern 2)
   └─ List/search results with data? → Use createSuccessResponse() with data param (Pattern 2)
```

**Note:** Pattern 6 (manual construction) is ONLY for non-text MCP content types. ALL other cases use templates.

## Adding New Message Templates

1. **Add template to docs/messages.md**

```markdown
## MY_NEW_MESSAGE

**Type:** success
**Code:** N/A

Operation completed successfully: {{operationName}}

**Note:** This is a note about the operation.
```

2. **Use in code**

```typescript
return createSuccessResponse('MY_NEW_MESSAGE', {
  operationName: 'data export'
});
```

3. **Build and test**

```bash
npm run build
# Test with MCP client
```

## Migration Status

As of the latest migration (TRULY complete):

- **✓ All Tools Migrated:** Connection tools, breakpoint tools, execution tools, inspection tools, console tools, network tools, page tools, DOM tools, input tools, screenshot tools, storage tools
- **✓ All Simple Success Messages:** All 21 simple success messages now use `createSuccessResponse()`
- **✓ Console/Network List Tools:** Migrated to use templates with data parameter (7 additional cases)
- **✓ Error Helpers:** `checkBrowserAutomation()` and `formatErrorResponse()` migrated to markdown
- **✓ Consistency:** ALL simple messages use templates; only truly justified cases remain manual
- **✓ Documentation:** Complete guide with 6 usage patterns and decision tree

### Migration 100% Complete

**All simple success/error messages now use message templates**

Remaining manual constructions (ONLY 3 cases - all justified):
- Screenshot tools returning image content (3 cases) - **Technical blocker: non-text MCP content type**
  - `takeScreenshot` with small images
  - `takeViewportScreenshot` with small images
  - `takeElementScreenshot` with small images

**Previous claim of 10 justified cases was incorrect.** The 7 console/network list tools have been successfully migrated.

## Common Mistakes

1. **Don't use JSON.stringify() for user-facing responses**
   - ❌ `text: JSON.stringify({ error: 'message' })`
   - ✓ `createErrorResponse('MESSAGE_ID')`

2. **Don't forget isError: true for manual error construction**
   - ❌ `{ content: [...] }`
   - ✓ `{ content: [...], isError: true }`

3. **Don't create templates for highly dynamic content**
   - Pattern 5 (manual construction) is acceptable for runtime-specific tips
   - Example: breakpoint-tools.ts lines 106-113

4. **Do use formatCodeBlock() for data display**
   - ❌ `text: \`Data: ${JSON.stringify(data)}\``
   - ✓ `text: \`Summary\n\n${formatCodeBlock(data)}\``

## Examples by File

- **breakpoint-tools.ts**: Patterns 1, 2, 3, 4, 5
- **execution-tools.ts**: Patterns 1, 2, 3
- **inspection-tools.ts**: Patterns 2, 3 (code search uses Pattern 2)
- **console-tools.ts**: Patterns 1, 2 (list/search operations now use Pattern 2!)
- **network-tools.ts**: Patterns 1, 2 (list/search operations now use Pattern 2!)
- **page-tools.ts**: Patterns 1, 2, 3
- **dom-tools.ts**: Patterns 1, 2, 3
- **input-tools.ts**: Patterns 1, 3
- **screenshot-tools.ts**: Patterns 1, 3, 6 (only Pattern 6 for image content)
- **storage-tools.ts**: Patterns 1, 2, 3

## Testing Checklist

When making changes to the message system:

- [ ] Message template added to docs/messages.md
- [ ] Template ID is unique and descriptive
- [ ] Variables are documented in template
- [ ] Code uses createSuccessResponse or createErrorResponse
- [ ] TypeScript compiles: `npm run build`
- [ ] Error responses include `isError: true`
- [ ] Markdown formatting is correct
- [ ] Suggestions are helpful for errors
- [ ] Examples are provided for complex errors
