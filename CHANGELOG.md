# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **UI Verification** (#26): `content({ action: 'verify' })` detects dead buttons, viewport issues, touch targets, overflow clipping, dead links, horizontal scroll
- **DOM Change Detection** (#27): Input actions report DOM changes via MutationObserver (added/removed elements, visibility changes)
- **Replay Agent**: `.claude/agents/replay-agent.md` for building sequences through investigation
- **Variable Inspection Fallbacks**: `getVariables` gracefully degrades when data exceeds token limits (#20)
- **Breakpoint Pause Detection**: Input actions (click, type, hover) now detect and report when they trigger breakpoints
- **TOON Format**: Token-Oriented Object Notation for compact inspection output (~58% token reduction)
- **Webpack Eval Support**: Code search (`searchCode`, `searchFunctions`) now extracts actual source lines from webpack eval wrappers instead of showing unhelpful `eval(__webpack_require__...)` lines
- **Lazy Source Map Loading**: Source maps are now registered and loaded on-demand instead of eagerly, improving startup performance
  - Size limits prevent performance issues (1MB inline, 10MB file)
  - Support for URL-encoded data URIs (not just base64)
  - Concurrent load protection prevents duplicate loads
  - Error tracking for debugging without blocking operations

### Fixed
- **Cache-Busting Breakpoints**: Breakpoints now work across rebuilds when scripts have changing query params (e.g., `app.js?v=123`)
  - Falls back to base URL matching when exact URL not found
  - Prefers most recently loaded script when multiple matches exist
- **Connection Reference Lookups**: References are now normalized (lowercase, trimmed, spaces→hyphens) for more flexible lookups

### Changed
- `loadSourceMaps` tool now registers maps for lazy loading and reports count; actual loading happens on-demand
- Long code search results truncated to 200 chars to prevent huge responses from minified code

---

## [0.2.0] - 2025-11-22

### Added
- **Enhanced Replay System**: Major improvements to command replay for workflow automation
  - Connection injection: Replay sequences across different Chrome sessions
  - Variable substitution: Replace text inputs with new values during replay
  - `intoHistory` option: Load sequences into history without executing
  - Step/total timeout configuration for replay control
  - Auto-launch Chrome if no active connection
  - Element validation after navigation/click actions
- **Chrome Lifecycle Tracking**: Track Chrome process close events with reasons
  - Close reasons: `inactivity`, `manual`, `crash`, `external`, `signal`, `unknown`
  - View close history via `getChromeStatus()`
  - Better debugging for unexpected Chrome terminations
- **Password Popup Prevention**: Automatically disable Chrome's password manager
  - Prevents save password prompts that block automation
  - Disables password leak detection popups
- **Startup Metrics**: Track MCP server startup performance
  - Measure import, port reservation, server creation times
  - View metrics when debug logging is enabled
  - New `npm run startup:measure` script for diagnostics

### Changed
- Simplified replay sequence storage format (commands inline, not indices)
- `recordCommand` is now async for better error handling
- Improved inactivity cleanup logging for debugging

### Fixed
- Circular dependency issues with port configuration (extracted to dedicated module)

### Technical
- Port configuration extracted to `src/port-config.ts`
- Added stdin close handler for proper cleanup when parent process terminates
- Added uncaught exception and unhandled rejection handlers

---

## [0.1.0] - 2025-11-14

### Added
- Initial release of CDP Tools MCP
- 72 tools for Chrome DevTools Protocol debugging
- Connection management (Chrome and Node.js)
- Breakpoint and logpoint support
- Execution control (pause, resume, step)
- Variable inspection and code search
- Network monitoring and request inspection
- Console log monitoring and search
- Browser automation (navigation, interaction)
- DOM inspection and querying
- Screenshot and PDF generation
- Storage access (cookies, localStorage)
- Content extraction and modal handling
- Token-efficient responses with smart truncation
- Automatic file saving for large data
- Pagination support for logs and requests

### Features
- **Runtime Debugging**: Set breakpoints, inspect variables, step through code
- **Logpoints**: Add logging without code changes (max 20 executions by default)
- **Network Analysis**: Monitor HTTP traffic with request/response inspection
- **Browser Automation**: Automate interactions to reproduce bugs
- **Token Optimization**: Smart truncation, file saving, and pagination
- **Multi-Connection**: Debug Chrome and Node.js simultaneously
- **Source Map Support**: Debug TypeScript with automatic source map loading

### Technical
- Built with Model Context Protocol SDK
- Uses Chrome DevTools Protocol via chrome-remote-interface
- TypeScript implementation with full type safety
- Comprehensive error handling and validation
- Zod schemas for parameter validation

[0.1.0]: https://github.com/InDate/cdp-tools-mcp/releases/tag/v0.1.0
