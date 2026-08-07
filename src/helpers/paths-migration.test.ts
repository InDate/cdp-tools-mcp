import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveStateDir } from './paths.js';

/**
 * The state directory holds things a user would miss if they silently vanished:
 * Chrome profiles carrying logins and IndexedDB, config, recorded sequences,
 * issues. These tests are about not losing them.
 */
describe('resolveStateDir', () => {
  let parent: string;

  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), 'devharness-migration-'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    try { chmodSync(parent, 0o755); } catch { /* already writable */ }
    rmSync(parent, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns the new path when nothing exists yet', () => {
    expect(resolveStateDir(parent)).toBe(join(parent, '.devharness'));
  });

  it('migrates a legacy directory, contents intact', () => {
    const legacy = join(parent, '.cdp-tools');
    mkdirSync(join(legacy, 'profiles', 'device-a'), { recursive: true });
    writeFileSync(join(legacy, 'config.json'), '{"chrome":{"headless":true}}');
    writeFileSync(join(legacy, 'profiles', 'device-a', 'cookies'), 'session=abc');

    const resolved = resolveStateDir(parent);

    expect(resolved).toBe(join(parent, '.devharness'));
    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(join(resolved, 'config.json'), 'utf-8')).toContain('headless');
    expect(readFileSync(join(resolved, 'profiles', 'device-a', 'cookies'), 'utf-8')).toBe('session=abc');
  });

  it('leaves a legacy directory alone once the new one exists', () => {
    // Someone downgraded, ran the old version, and it recreated .cdp-tools.
    // The new directory is authoritative; the stale one is not merged in,
    // because merging two divergent profile stores would silently pick winners.
    const legacy = join(parent, '.cdp-tools');
    const current = join(parent, '.devharness');
    mkdirSync(legacy, { recursive: true });
    mkdirSync(current, { recursive: true });
    writeFileSync(join(legacy, 'config.json'), '{"from":"legacy"}');
    writeFileSync(join(current, 'config.json'), '{"from":"current"}');

    expect(resolveStateDir(parent)).toBe(current);
    expect(readFileSync(join(current, 'config.json'), 'utf-8')).toContain('current');
    expect(existsSync(legacy)).toBe(true);
  });

  it('falls back to the legacy directory when the rename fails', () => {
    // A fresh empty directory would look like data loss to the user, with no
    // way to connect it to an upgrade. Keep using what still has their data.
    const legacy = join(parent, '.cdp-tools');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'config.json'), '{"kept":true}');
    chmodSync(parent, 0o500); // read+execute: can traverse, cannot rename

    const resolved = resolveStateDir(parent);

    expect(resolved).toBe(legacy);
    expect(readFileSync(join(resolved, 'config.json'), 'utf-8')).toContain('kept');
  });
});
