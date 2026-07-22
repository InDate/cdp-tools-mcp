# cdp-tools MCP Server

Chrome DevTools Protocol debugging for JavaScript/TypeScript in Chrome, Node.js, or CDP-compatible environments - breakpoints, variable inspection, browser automation, dev server management, and record/replay verification.

**Quick start (web apps):**
1. `launchChrome({ reference: "name" })` - launches AND auto-connects, ready immediately (do not call `connectDebugger` after this)
2. `navigate({ action: 'goto', connectionReason: "name", url: "..." })` - also caches interactive elements for the page
3. `content({ action: 'findInteractive' })` / `content({ action: 'extractText', mode: 'outline' })` to read the page
4. Use other tools with `connectionReason: "name"`

**Node.js:** start with `node --inspect=9229 app.js`, then `connectDebugger({ reference: "name", port: 9229 })`.

For full workflow guidance, key practices, common debugging/performance/replay patterns, and the complete tool catalog: this package ships an Agent Skills-compatible skill at `skills/cdp-tools/SKILL.md`. Clients that support Agent Skills (agentskills.io) will auto-discover it once it's placed in a scanned skills directory (e.g. `.claude/skills/` or `.agents/skills/`) and load it only when a debugging task is actually underway. If your client doesn't support Agent Skills, see `docs/instructions.md` for the same material inline, or rely on each tool's own description.

If cdp-tools itself seems stuck or broken (not the target app), restart it yourself: `config({ action: 'restart' })` (falls back to `kill -USR2 $(cat .cdp-tools/mcp-supervisor.pid)` if that's unavailable). This kills any Chrome instances it launched (relaunch with `launchChrome`); managed dev servers (`server` tool) survive and reattach automatically.
