# Page-parser plugins

`content({ action: 'parse' })` runs small, user-written parser plugins against
the current page and returns their JSON output. Plugins are **not** shipped with
cdp-tools — you write the ones you need.

## Usage

```js
content({ action: 'parse' })                      // list installed plugins (+ URL match)
content({ action: 'parse', name: 'ai-overview' }) // run a plugin
content({ action: 'parse', name: 'x', waitMs: 0 })// skip the waitFor gate
```

Plugins are dynamically imported at call time (cache-busted), so adding or
editing one takes effect immediately — **no rebuild or server restart**.

## Where plugins live

Loaded from, in order:

1. `./.devharness/parsers/` — project-local (overrides global on name collision)
2. `~/.devharness/parsers/` — global, shared across projects

> Note: the MCP server often runs with a neutral working directory, so it
> resolves to the **global** `~/.devharness/parsers/` by default. Put plugins
> there unless you've pointed the server at a project with
> `config({ action: 'useLocal', path: '/abs/project' })`.

## Contract

A plugin is an ES module (`.mjs`) that default-exports:

```js
export default {
  name: 'my-parser',                 // required, unique
  description: 'What it extracts',   // shown by `parse` (list)
  match: /example\.com/,             // optional: flags "matches current URL"
  waitFor: () => boolean,            // optional: runs IN the page
  extract: () => any,                // required: runs IN the page -> JSON
};
```

- `extract()` runs in the browser via `page.evaluate` and returns any
  JSON-serializable value — that value is what `parse` returns.
- `waitFor()` also runs in the page. The tool waits (up to `waitMs`, default
  8000) until it returns `true` before extracting — useful for content that
  streams in after load. Pass `waitMs: 0` to skip.

### The one rule

`waitFor` and `extract` are serialized and executed in the page, so they must be
**self-contained**: no closures over Node/module scope, no imports. Define any
helpers inside the function body.

## Worked example: Google AI Overview

Save as `~/.devharness/parsers/ai-overview.mjs`:

```js
export default {
  name: 'ai-overview',
  description: 'Google AI Overview summary text + cited source links',
  match: /google\.[a-z.]+\/search/i,

  waitFor: () => {
    const t = document.body ? document.body.innerText || '' : '';
    const hasHeading = Array.from(
      document.querySelectorAll('h1, h2, h3, div[role="heading"], span, div')
    ).some((e) => (e.textContent || '').trim() === 'AI Overview');
    const settled = /not available for this search|Can.?t generate an AI overview/i.test(t);
    return hasHeading || settled;
  },

  extract: () => {
    const isVisible = (el) => !!(el && el.offsetParent !== null);
    const heading = Array.from(
      document.querySelectorAll('h1, h2, h3, div[role="heading"], span, div')
    ).find((e) => (e.textContent || '').trim() === 'AI Overview' && isVisible(e));

    const bodyText = document.body ? document.body.innerText || '' : '';
    const notAvailable = /not available for this search|Can.?t generate an AI overview/i.test(bodyText);
    if (!heading) {
      return { generated: false, reason: notAvailable ? 'not_available' : 'no_overview', summary: '', links: [] };
    }

    // Climb to the container that excludes the organic results.
    let node = heading;
    while (node.parentElement && !node.parentElement.querySelector('#rso, #search, #botstuff')) {
      node = node.parentElement;
    }
    const container = node;

    let text = (container.innerText || '').replace(/^\s*AI Overview\s*/, '');
    const cutMarkers = [
      /\d+\s+sites\b/i, /People also ask/i, /Show more\b/i, /Show all\b/i,
      /Generative AI is experimental/i, /AI responses may include/i, /Sponsored\b/i,
    ];
    let cut = text.length;
    for (const rx of cutMarkers) {
      const m = text.match(rx);
      if (m && m.index != null) cut = Math.min(cut, m.index);
    }
    const summary = text.slice(0, cut).trim();

    const seen = new Map();
    container.querySelectorAll('a[href]').forEach((a) => {
      const href = a.href || a.getAttribute('href') || '';
      if (!/^https?:\/\//i.test(href)) return;
      let host = '';
      try { host = new URL(href).hostname.replace(/^www\./, ''); } catch (e) { return; }
      if (/(^|\.)(google\.|gstatic\.|googleusercontent\.)/.test(host)) return;
      const title = (a.innerText || a.getAttribute('aria-label') || '').trim();
      if (seen.has(href)) { const r = seen.get(href); if (title && !r.title) r.title = title; return; }
      seen.set(href, { url: href, domain: host, title: title || null });
    });

    return {
      generated: summary.length > 0,
      reason: summary.length > 0 ? 'ok' : (notAvailable ? 'not_available' : 'empty'),
      summary,
      links: Array.from(seen.values()),
    };
  },
};
```

Run it on a Google results page:

```js
content({ action: 'parse', name: 'ai-overview', waitMs: 15000 })
```
