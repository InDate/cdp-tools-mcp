# Contributing

```sh
npm install
npm run build
npm run test:run
```

## Running your build

`plugin/` is what ships to users: the manifest, the skill, and `plugin/.mcp.json`
pointing at the published package. It deliberately has no `package.json` - a
plugin directory containing one gets a full `npm install` on every install,
which cost 175MB of dev dependencies per version before this was split out.

Register your build as a separate server instead:

```sh
npm run build
claude mcp add devharness-dev -- node build/mcp-supervisor.js
```

Both load at once — `mcp__devharness__*` from the published package,
`mcp__devharness-dev__*` from your build — which makes it easy to check one
against the other.

`npm run build` signals the running supervisor to hot-reload, so a rebuild is
usually enough. If behaviour still looks stale, `config({ action: 'status' })`
reports which entry file is actually answering and when it was built.

## Before a PR

```sh
npm run test:run      # 802 tests, ~7s
npm run build:verify  # starts the server, checks the shipped docs match the tools
```

`build:verify` is the release gate. It fails if `docs/instructions.md` or
`plugin/skills/devharness/references/tool-categories.md` disagree with the tools the
server actually registers, or if the skill's version stamp doesn't match
`package.json`. Those files ship to users, so drift there is a user-facing bug.

## Releasing

Version lives in three places that must agree: `package.json`,
`plugin/skills/devharness/SKILL.md` frontmatter, and `plugin/.mcp.json`. `build:verify` catches
the first two; the third is the version the plugin installs.

```sh
# bump all three, then
git tag v0.8.1 && git push origin v0.8.1
```

The tag triggers two workflows: `publish.yml` publishes to npm with provenance,
and `notify-marketplace.yml` asks
[InDate/indate-tools](https://github.com/InDate/indate-tools) to repin. The
marketplace opens a PR rather than repinning itself — publishing and pushing an
update to installed users are separate decisions.
