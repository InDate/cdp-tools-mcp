import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClientWatcher, resolveClientIdentity, type ProcessInfo, type ProcessProbe } from './client-watcher.js';

/** Builds a probe over a fake process table: pid -> { ppid, command }. */
function makeProbe(table: Record<number, ProcessInfo>, dead = new Set<number>()): ProcessProbe {
  return {
    info: (pid) => (dead.has(pid) ? null : table[pid] ?? null),
    isAlive: (pid) => !dead.has(pid) && pid in table,
  };
}

describe('resolveClientIdentity', () => {
  it('finds the client through an npm exec wrapper', () => {
    // node <- npm exec <- claude, the shape a `npx cdp-tools-mcp` launch takes
    const probe = makeProbe({
      100: { ppid: 200, command: '/opt/node/bin/node /path/.bin/cdp-tools-mcp' },
      200: { ppid: 300, command: 'npm exec cdp-tools-mcp@latest' },
      300: { ppid: 400, command: 'claude' },
      400: { ppid: 1, command: '/bin/zsh' },
    });

    expect(resolveClientIdentity(100, probe)).toEqual({ pid: 300, command: 'claude' });
  });

  it('finds the desktop app helper below the app itself', () => {
    const probe = makeProbe({
      100: { ppid: 200, command: 'node .bin/cdp-tools-mcp' },
      200: { ppid: 300, command: 'npm exec cdp-tools-mcp@latest' },
      300: { ppid: 400, command: '/Applications/Claude.app/Contents/Helpers/disclaimer' },
      400: { ppid: 1, command: '/Applications/Claude.app/Contents/MacOS/Claude' },
    });

    const client = resolveClientIdentity(100, probe);
    expect(client?.pid).toBe(300);
  });

  it('treats an npm-installed node host as the client, not as plumbing', () => {
    // The host itself is a node script here, so a rule that called every node
    // process plumbing would walk past it to the shell and terminal - which
    // outlive the client, leaving the tree unreaped.
    const probe = makeProbe({
      100: { ppid: 200, command: 'node /Users/x/.npm/_npx/abc/node_modules/.bin/cdp-tools-mcp' },
      200: { ppid: 300, command: 'npm exec cdp-tools-mcp@latest' },
      300: { ppid: 400, command: 'node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js' },
      400: { ppid: 500, command: '/bin/zsh -l' },
      500: { ppid: 1, command: '/Applications/iTerm.app/Contents/MacOS/iTerm2' },
    });

    expect(resolveClientIdentity(100, probe)?.pid).toBe(300);
  });

  it('still walks past npm and npx machinery running under node', () => {
    const probe = makeProbe({
      100: { ppid: 200, command: 'node /path/node_modules/.bin/cdp-tools-mcp' },
      200: { ppid: 300, command: 'node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js exec' },
      300: { ppid: 1, command: 'claude' },
    });

    expect(resolveClientIdentity(100, probe)?.pid).toBe(300);
  });

  it('treats a bare runtime with no script as plumbing', () => {
    const probe = makeProbe({
      100: { ppid: 200, command: 'node /path/.bin/cdp-tools-mcp' },
      200: { ppid: 300, command: 'node' },
      300: { ppid: 1, command: 'code-helper' },
    });

    expect(resolveClientIdentity(100, probe)?.pid).toBe(300);
  });

  it('returns null when every ancestor is launch plumbing', () => {
    const probe = makeProbe({
      100: { ppid: 200, command: 'node /path/node_modules/.bin/cdp-tools-mcp' },
      200: { ppid: 300, command: 'npm exec cdp-tools-mcp@latest' },
      300: { ppid: 1, command: '/bin/bash' },
    });

    expect(resolveClientIdentity(100, probe)).toBeNull();
  });

  it('returns null when the ancestry is unreadable', () => {
    expect(resolveClientIdentity(100, makeProbe({}))).toBeNull();
  });

  it('gives up rather than looping on a deep ancestry', () => {
    // Every entry is plumbing, so a bounded walk is the only thing that stops it.
    const table: Record<number, ProcessInfo> = {};
    for (let pid = 100; pid < 200; pid++) {
      table[pid] = { ppid: pid + 1, command: 'npm exec something' };
    }
    expect(resolveClientIdentity(100, makeProbe(table), 5)).toBeNull();
  });
});

describe('ClientWatcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const TABLE: Record<number, ProcessInfo> = {
    100: { ppid: 200, command: 'node .bin/cdp-tools-mcp' },
    200: { ppid: 300, command: 'npm exec cdp-tools-mcp@latest' },
    300: { ppid: 1, command: 'claude' },
  };

  it('calls back once the client is gone', () => {
    const dead = new Set<number>();
    const watcher = new ClientWatcher({ pollIntervalMs: 1000, probe: makeProbe(TABLE, dead) });
    const onGone = vi.fn();

    expect(watcher.start(100, onGone)).toEqual({ pid: 300, command: 'claude' });

    vi.advanceTimersByTime(3000);
    expect(onGone).not.toHaveBeenCalled();

    dead.add(300);
    vi.advanceTimersByTime(1000);
    expect(onGone).toHaveBeenCalledTimes(1);
    expect(onGone).toHaveBeenCalledWith({ pid: 300, command: 'claude' });

    // Stops polling after firing - one shutdown is enough.
    vi.advanceTimersByTime(10_000);
    expect(onGone).toHaveBeenCalledTimes(1);
  });

  it('watches nothing when no client can be identified', () => {
    const watcher = new ClientWatcher({ pollIntervalMs: 1000, probe: makeProbe({}) });
    const onGone = vi.fn();

    expect(watcher.start(100, onGone)).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(onGone).not.toHaveBeenCalled();
  });

  it('stops polling when stopped', () => {
    const dead = new Set<number>();
    const watcher = new ClientWatcher({ pollIntervalMs: 1000, probe: makeProbe(TABLE, dead) });
    const onGone = vi.fn();

    watcher.start(100, onGone);
    watcher.stop();
    dead.add(300);

    vi.advanceTimersByTime(10_000);
    expect(onGone).not.toHaveBeenCalled();
  });
});
