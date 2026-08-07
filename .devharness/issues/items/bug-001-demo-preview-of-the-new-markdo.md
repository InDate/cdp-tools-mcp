---
id: 1
type: bug
status: acknowledged
title: "Demo: preview of the new Markdown issue format"
labels: ["ui", "checkout", "demo"]
sequenceFile: "bug-001-demo-preview-of-the-new-markdo.json"
startUrl: "about:blank"
recordingName: "manual"
reportedAt: 2026-07-22T10:20:29.217Z
acknowledgedAt: 2026-07-22T10:20:29.217Z
---

## Steps to reproduce
1. Open the checkout page on a throttled connection
2. Click "Submit" once
3. Click "Submit" again before the spinner appears

## Expected
The second click is ignored (button should disable itself after the first click).

## Actual
Two orders get created — the double-click isn't debounced.

```js
// suspect this handler is missing a guard
submitButton.addEventListener('click', handleSubmit);
```

<!-- comment: 2026-07-22T10:20:45.935Z -->
Reproduced on Chrome 120 too — not throttling-specific. Looks like `handleSubmit` needs a `disabled` guard or a debounce.

<!-- comment: 2026-07-22T10:29:06.823Z -->
Confirming the live server picked up the externally-linked sequence file via the watcher.
