# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
