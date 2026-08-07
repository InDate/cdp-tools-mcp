---
id: 2
type: bug
status: acknowledged
title: "issues create rejects startUrl \"about:blank\" with ISSUES_INVALID_START_URL"
startUrl: "about:blank"
recordingName: "manual"
reportedAt: 2026-07-24T03:05:02.825Z
acknowledgedAt: 2026-07-24T03:05:02.825Z
---

## Steps to reproduce
Call `issues` with `action: "create"` and `startUrl: "about:blank"`.

## Expected
`about:blank` is accepted as a valid `startUrl` — it shows up in the frontmatter of existing issue files (likely grandfathered in from issues originally created via browser recording, not this API), so the API should tolerate it too.

## Actual
The call is rejected with `ISSUES_INVALID_START_URL`. The tool appears to validate `startUrl` as a real URL format, which `about:blank` doesn't satisfy. Swapping in a real `https://...` URL succeeds on retry.

## Notes
Either relax the validation to allow `about:blank` (and other special browser URLs already present in existing issue data), or document that only `http(s)://` URLs are accepted for `startUrl` going forward.
