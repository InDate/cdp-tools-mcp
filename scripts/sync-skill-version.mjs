#!/usr/bin/env node
/**
 * Sync the Agent Skill's version stamp to package.json.
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

import { readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const skillPath = join(repoRoot, 'skills', 'cdp-tools', 'SKILL.md');

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
