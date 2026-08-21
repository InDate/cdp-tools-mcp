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

### Hot reload

`mcp-supervisor.js` is the `bin` entrypoint; it supervises `build/index.js` as a
child. On SIGUSR2 — from the postbuild hook, `kill -USR2 $(cat
.devharness/mcp-supervisor.pid)`, or the `config({ action: 'restart' })` tool —
it restarts that child and sends `notifications/tools/list_changed`. So a
rebuild is usually enough; no `/mcp` reconnect.

- Chrome instances the old child launched are killed — call `launchChrome` again.
- Managed dev servers survive and reattach; they live outside the child's lifetime.
- `config({ action: 'restart' })` is itself in the frozen tool list, so testing a
  change to the restart mechanism runs the *old* tool until the restart completes.

The build reports `Sent SIGUSR2 to mcp-supervisor (PID n)` or `No pidfile ...
nothing to reload`. Read that line before reading code when behaviour
contradicts your source — but it is a claim about a pid, not proof your session
reloaded. The build signals whoever is named in *this repo's* pidfile, which is
someone else's supervisor when your session is supervised from another
directory. Ask the running server instead:

```
config({ action: 'status' })
```

`Built:` is the mtime of the `build/index.js` the process actually loaded;
`Running:` is which file that is. Older than the build you just ran means you
are talking to previous code. Check this before concluding your source is wrong
— hours have gone into debugging a fix that already worked.

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
npm run test:run      # vitest, ~15s; tests are colocated as *.test.ts
npm run build:verify  # starts the server, checks the shipped docs match the tools
```

`build:verify` is the release gate. It fails if `docs/instructions.md` or
`plugin/skills/devharness/references/tool-categories.md` disagree with the tools the
server actually registers, or if the skill's version stamp doesn't match
`package.json`. Those files ship to users, so drift there is a user-facing bug.

`npm run stress:suspend` drives the built supervisor as a real process — idle
suspend, orphan reaping, requests landing inside the teardown window, RSS/fd
across cycles, signal collisions, kill escalation. Needs a build first, takes
minutes, deliberately outside `npm test`. Run named scenarios (`-- race leak`),
change the loop count (`-- --cycles=200`), skip the slow real-Chrome ones
(`-- --skip=release,shared`); `STRESS_VERBOSE=1` shows supervisor stderr. Run it
whenever `src/supervisor/` or `src/server-claims.ts` changes — `release` and
`shared` pin the dev-server ownership rule, and a regression there kills a
server someone else is using.

`npm run check:targets` attaches the built `NetworkMonitor` to a real Chrome and
checks that a target held by auto-attach is released: a service worker
registers, a registration for a missing script rejects with its 404, and a
dedicated worker runs. Needs a build first, takes seconds, outside `npm test`
because the vitest suite never spawns Chrome. Run it whenever the
`Target.attachedToTarget` handler in `src/network-monitor.ts` changes — a resume
that waits on a pending CDP send leaves the target held, and every service
worker registration in a devharness-driven Chrome then hangs. `--headful` shows
the window; `CHECK_PORT` moves the fixture server off 45901.

`npm run check:workers` registers a service worker in a real Chrome and drives
`WorkerTargetRegistry` against it: the target is listed, an expression
evaluates inside `ServiceWorkerGlobalScope`, its console output is recorded,
and a reference matching nothing is refused. Needs a build first, outside
`npm test` for the same reason. Run it whenever `src/worker-targets.ts` or the
`target` parameter on `inspect`/`console` changes.

When you add, rename, or change a tool, update `docs/instructions.md`,
`docs/mcp-instructions.md` (if it affects the quick-start),
`plugin/skills/devharness/SKILL.md` and `references/tool-categories.md`, and
`docs/messages.md` (if it returns new response types). These are kept in sync by
hand; `build:verify` is what catches you.

## Releasing

Version lives in three places that must agree: `package.json`,
`plugin/skills/devharness/SKILL.md` frontmatter, and `plugin/.mcp.json` — the
last being the version the plugin actually installs. `build:verify` checks all
three.

```sh
npm run build:verify   # the gate — run it BEFORE bumping
npm version patch      # bumps all three, commits, tags, and pushes
```

`npm version` is the whole release. Its `version` hook
(`scripts/sync-skill-version.mjs`) stamps the skill and the pin into the version
commit, and `postversion` pushes the branch and tag with no confirmation step —
so make `main` exactly what should ship before bumping, and never run
`npm publish` by hand.

The tag triggers two workflows: `publish.yml` publishes to npm with provenance,
and `notify-marketplace.yml` asks
[InDate/indate-tools](https://github.com/InDate/indate-tools) to repin. The
marketplace opens a PR rather than repinning itself — publishing and pushing an
update to installed users are separate decisions.

Running `build:verify` after the tag is too late: the tag is public, the publish
run fails on whichever of the three is stale, and the marketplace has meanwhile
opened a PR pinning a version npm never received.
