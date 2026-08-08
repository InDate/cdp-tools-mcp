#!/usr/bin/env node
/**
 * Sync the version into the two other places it lives: the Agent Skill's
 * frontmatter stamp and the version `plugin/.mcp.json` installs.
 *
 * Runs from the npm `version` lifecycle, which fires AFTER package.json is
 * bumped and BEFORE the version commit is made - so staging the file here
 * folds it into that same commit.
 *
 * Without this, the release sequence is a trap: `postversion` pushes the
 * commit and tag immediately, and `prepublishOnly` then runs verify-mcp.js,
 * which fails because SKILL.md still carries the previous version. The tag is
 * public by the time you find out.
 *
 * The stamp exists so the server can spot a skill copied (rather than
 * symlinked) from an older release and tell the user it is stale - see
 * getSkillInstallState in src/index.ts.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const skillPath = join(repoRoot, 'plugin', 'skills', 'devharness', 'SKILL.md');

if (!existsSync(skillPath)) {
  // A raw ENOENT stack out of the npm `version` lifecycle reads as "release is
  // broken" rather than "this path moved" - which is exactly what happened when
  // the skill moved out of skills/cdp-tools/.
  console.error(`[sync-skill-version] No SKILL.md at ${skillPath} - update this script if the skill moved.`);
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));
const skill = readFileSync(skillPath, 'utf-8');

if (!/^version:\s*.+$/m.test(skill)) {
  console.error(`[sync-skill-version] No 'version:' field in ${skillPath} frontmatter - add one.`);
  process.exit(1);
}

const updated = skill.replace(/^version:\s*.+$/m, `version: ${version}`);

if (updated === skill) {
  console.log(`[sync-skill-version] SKILL.md already at ${version}`);
} else {
  writeFileSync(skillPath, updated);
  console.log(`[sync-skill-version] SKILL.md stamped ${version}`);
}

// Stage it either way: on a re-run the file may already be correct but unstaged.
execFileSync('git', ['add', skillPath], { cwd: repoRoot });

/**
 * The third place the version lives: what the plugin actually installs. Left
 * to a human it gets forgotten, and the failure is late and loud - the tag is
 * already public, publish.yml fails its verify step, and notify-marketplace
 * has meanwhile opened a PR pinning a version npm never got.
 */
const pinPath = join(repoRoot, 'plugin', '.mcp.json');

if (!existsSync(pinPath)) {
  console.error(`[sync-skill-version] No plugin manifest at ${pinPath} - update this script if it moved.`);
  process.exit(1);
}

const pinSource = readFileSync(pinPath, 'utf-8');
const pinned = /"devharness@([^"]+)"/.exec(pinSource);

if (!pinned) {
  console.error(`[sync-skill-version] No "devharness@<version>" arg in ${pinPath} - cannot bump the pin.`);
  process.exit(1);
}

if (pinned[1] === version) {
  console.log(`[sync-skill-version] plugin/.mcp.json already pins ${version}`);
} else {
  writeFileSync(pinPath, pinSource.replace(/"devharness@[^"]+"/, `"devharness@${version}"`));
  console.log(`[sync-skill-version] plugin/.mcp.json pinned ${pinned[1]} -> ${version}`);
}

execFileSync('git', ['add', pinPath], { cwd: repoRoot });
