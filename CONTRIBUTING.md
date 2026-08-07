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

### The plugin's own server fails inside this repo

If you have the Claude Code plugin installed, its server won't start while your
working directory is this repository:

```
sh: devharness: command not found
MCP error -32000: Connection closed
```

Expected, and only here. The plugin runs `npx -y devharness@<version>`. `npm exec`
reads this repo's `package.json`, sees the same name and version, decides the
spec is already satisfied, and skips the install — then looks for a `devharness`
bin in `node_modules/.bin`, which npm never links for a package's own bin. From
any other directory npx fetches from the registry and it works.

Use `devharness-dev` here; that is what it is for. Do **not** fix it by linking
`node_modules/.bin/devharness` to your build. It works, but it makes the plugin
run your working tree while claiming to run a pinned published version — which is
the exact thing the version pin exists to prevent, and you would be debugging
against code no user has.

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
