import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setWorkingDirOverride } from './helpers/paths.js';
import {
  __resetForTests,
  addIssue,
  getIssue,
  getIssues,
  addIssueComment,
  getIssueItemsDir,
} from './issue-tracker.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(join(tmpdir(), 'cdp-tools-issue-test-'));
  setWorkingDirOverride(tempDir);
  __resetForTests();
});

afterEach(async () => {
  __resetForTests();
  await fsp.rm(tempDir, { recursive: true, force: true });
});

describe('issue-tracker', () => {
  it('round-trips title/body/labels through frontmatter, including special characters', async () => {
    const created = await addIssue({
      type: 'bug',
      title: 'Bug: submit fails "hard" & breaks',
      body: '## Steps\n1. Click submit\n2. Watch it fail',
      labels: ['ui', 'checkout'],
    });

    // Drop the in-memory index and re-read straight from disk to actually
    // exercise the serialize -> file -> parse round trip.
    __resetForTests();

    const reloaded = await getIssue(created.id);
    expect(reloaded).toBeDefined();
    expect(reloaded!.title).toBe('Bug: submit fails "hard" & breaks');
    expect(reloaded!.body).toBe('## Steps\n1. Click submit\n2. Watch it fail');
    expect(reloaded!.labels).toEqual(['ui', 'checkout']);
    expect(reloaded!.type).toBe('bug');
    expect(reloaded!.status).toBe('pending');
  });

  it('round-trips multiple comments, preserving order and markdown content', async () => {
    const issue = await addIssue({ type: 'feature', title: 'Add dark mode' });
    await addIssueComment(issue.id, 'First: tried on Chrome, works.');
    await addIssueComment(issue.id, '```js\nconsole.log("ok")\n```\nFixed in commit abc123.');

    __resetForTests();

    const reloaded = await getIssue(issue.id);
    expect(reloaded!.comments).toHaveLength(2);
    expect(reloaded!.comments[0].text).toBe('First: tried on Chrome, works.');
    expect(reloaded!.comments[1].text).toBe('```js\nconsole.log("ok")\n```\nFixed in commit abc123.');
    expect(reloaded!.comments[0].timestamp.getTime()).toBeLessThanOrEqual(
      reloaded!.comments[1].timestamp.getTime()
    );
  });

  it('migrates a legacy issues.csv into one .md file per row and renames it to .bak', async () => {
    const issuesDir = join(tempDir, '.cdp-tools', 'issues');
    await fsp.mkdir(issuesDir, { recursive: true });

    const csvHeader = 'id,type,status,description,sequence_file,start_url,reported_at,acknowledged_at,started_at,resolved_at,recording_name';
    const csvRow = '1,bug,pending,"Login button, does ""nothing""",,http://localhost:3000,2026-01-01T00:00:00.000Z,,,,manual';
    await fsp.writeFile(join(issuesDir, 'issues.csv'), `${csvHeader}\n${csvRow}\n`, 'utf-8');

    const issues = await getIssues({ includeCompleted: true });

    expect(issues).toHaveLength(1);
    expect(issues[0].title).toBe('Login button, does "nothing"');
    expect(issues[0].body).toBe('');
    expect(issues[0].type).toBe('bug');
    expect(issues[0].status).toBe('pending');

    const items = await fsp.readdir(join(issuesDir, 'items'));
    expect(items.filter(f => f.endsWith('.md'))).toHaveLength(1);

    await expect(fsp.access(join(issuesDir, 'issues.csv.bak'))).resolves.toBeUndefined();
    await expect(fsp.access(join(issuesDir, 'issues.csv'))).rejects.toThrow();
  });

  it('picks up an externally-written issue file after the debounce window', async () => {
    // Prime the index/watcher with an initial (empty) load.
    await getIssues();

    const itemsDir = getIssueItemsDir();
    await fsp.mkdir(itemsDir, { recursive: true });
    const externalFile = [
      '---',
      'id: 42',
      'type: feature',
      'status: pending',
      'title: "Externally added issue"',
      'reportedAt: 2026-01-01T00:00:00.000Z',
      '---',
      '',
      'Added directly to disk, not through addIssue().',
      '',
    ].join('\n');
    await fsp.writeFile(join(itemsDir, 'feature-042-externally-added-issue.md'), externalFile, 'utf-8');

    // Wait past the debounce window for the watcher's rescan to land.
    await new Promise(resolve => setTimeout(resolve, 500));

    const issues = await getIssues();
    expect(issues.some(i => i.id === 42 && i.title === 'Externally added issue')).toBe(true);
  });
});
