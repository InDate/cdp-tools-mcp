---
id: 17
type: bug
status: acknowledged
title: "findInteractive returns another connection's cached page, so selectors come from the wrong browser"
startUrl: "about:blank"
recordingName: "manual"
reportedAt: 2026-07-26T11:05:00.000Z
acknowledgedAt: 2026-07-26T11:05:00.000Z
---

## Steps to reproduce

Two Chrome instances on the same origin, logged in as different users:

```
launchChrome({ reference: 'duo owner console',  forceNewInstance: true })
launchChrome({ reference: 'duo member device',  forceNewInstance: true })
# drive each to a DIFFERENT view of the same app
content({ action: 'findInteractive', connectionReason: 'duo-owner-console' })   # owner view
content({ action: 'findInteractive', connectionReason: 'duo-member-device' })   # member view
```

## Expected

The second call describes the member's page.

## Actual

It returns the **owner's** page, tagged `(cached)` — including buttons that do not exist in the member browser at all (`Approve`, `Reject`, `Retire`, the owner's people rail). `content({action:'extractText'})` against the same connection immediately after returns the correct member page, so the browsers are genuinely different and the connection routing is fine; it is the interactive-element cache that is shared.

Both pages are `https://cue-test.pages.dev/`, which is the likely trigger: the cache appears keyed on URL (populated by navigation, per the documented "navigation automatically caches interactive elements") without the connection as part of the key. Two connections on the same URL collide.

## Why it matters

This is silently wrong rather than loudly wrong, and it lands squarely on the multi-browser workflow the recent `connectionReason` work exists to support. Concretely: building a two-browser sequence, `findInteractive` is the natural way to discover selectors for the second browser — and it hands back selectors from the first. A sequence built on those selectors fails at run time with "element not found", and the obvious diagnosis (bad selector, timing) is wrong.

Worse for an agent driving unattended: the returned list is plausible. Nothing about `Approve`/`Reject` looks impossible on a page you have not otherwise read, so there is no signal to distrust it.

## Fix

Key the interactive cache on `(connectionReason, url)` rather than `url`. Worth auditing any other per-page cache for the same assumption — the same-origin-two-browsers case is now a first-class use case, not an edge case.

Failing that, at minimum stamp the cached entry with the connection it came from and refuse to serve it to a different one.

## Notes

Found while building an owner-approves-member's-take sequence across two browsers on one deployment. `extractText` was unaffected in the same session, so a workaround is to prefer `extractText` over `findInteractive` when more than one connection is on the same origin — but that is exactly the situation where selector discovery is most needed.
