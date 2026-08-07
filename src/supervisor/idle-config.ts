/**
 * Reads the idle-suspend settings for the supervisor.
 *
 * The supervisor runs before (and outlives) the real server, and deliberately
 * stays free of the server's module graph - so it cannot use ConfigManager,
 * which loads Zod, the debug logger and everything downstream of them. It
 * reads the same `.devharness/config.json` directly instead, and falls back to
 * the shipped defaults on anything unreadable.
 *
 * Precedence: env var > config file > default.
 */
import { readFileSync } from 'fs';

export const DEFAULT_IDLE_SUSPEND_MINUTES = 120;
export const DEFAULT_CLIENT_POLL_SECONDS = 60;

export interface SupervisorSessionConfig {
  /** Minutes of host silence before the child is suspended. 0 disables it. */
  idleSuspendMinutes: number;
  /** How often to check the MCP client is still alive. */
  clientPollSeconds: number;
}

function readNumber(value: unknown): number | null {
  // `Number('')` is 0, which would read as a deliberate "never suspend" - an
  // empty exported env var is an accident, not a setting.
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

/**
 * How often to test for idleness, given the threshold.
 *
 * A quarter of the threshold, so a suspend lands within ~25% of it, but never
 * more often than every 5 minutes - at the 2h default that is 5 minutes, and
 * the timer is otherwise doing nothing all day. The 1s floor only matters for
 * the sub-minute thresholds used by the stress harness.
 *
 * Pure and exported so the production timings are actually tested, rather than
 * only reasoned about: the default threshold is too long to wait out in a test.
 */
export function idleCheckIntervalMs(idleThresholdMs: number): number {
  return Math.max(1_000, Math.min(idleThresholdMs / 4, 5 * 60_000));
}

export interface ReadSessionConfigDeps {
  /** Path to config.json, as resolved by getConfigPath(). */
  configPath: string;
  /** Path to ~/.devharness/config.json, followed when the local file defers to it. */
  globalConfigPath?: string;
  env?: NodeJS.ProcessEnv;
  readFile?: (path: string) => string;
}

export function readSupervisorSessionConfig(deps: ReadSessionConfigDeps): SupervisorSessionConfig {
  const env = deps.env ?? process.env;
  const read = deps.readFile ?? ((p: string) => readFileSync(p, 'utf-8'));

  const readSession = (path: string): { session: Record<string, unknown> | null; deferred: boolean } => {
    try {
      const parsed = JSON.parse(read(path));
      if (!parsed || typeof parsed !== 'object') return { session: null, deferred: false };
      const session = typeof parsed.session === 'object' && parsed.session ? (parsed.session as Record<string, unknown>) : null;
      return { session, deferred: parsed.configLocation === 'global' };
    } catch {
      // No config file yet, or unreadable/corrupt - defaults are fine.
      return { session: null, deferred: false };
    }
  };

  const local = readSession(deps.configPath);
  let fromFile = local.session ?? {};
  // `config({ action: 'useGlobal' })` leaves a local stub holding nothing but
  // `configLocation: 'global'`, and getConfigPath() returns that stub because
  // it exists. Reading only it would silently ignore the settings the user
  // actually wrote, in the file the config tool shows them.
  if (local.deferred && !local.session && deps.globalConfigPath) {
    fromFile = readSession(deps.globalConfigPath).session ?? {};
  }

  const idleSuspendMinutes =
    readNumber(env.CDP_TOOLS_IDLE_SUSPEND_MINUTES) ??
    readNumber(fromFile.idleSuspendMinutes) ??
    DEFAULT_IDLE_SUSPEND_MINUTES;

  const clientPollSeconds =
    readNumber(env.CDP_TOOLS_CLIENT_POLL_SECONDS) ??
    readNumber(fromFile.clientPollSeconds) ??
    DEFAULT_CLIENT_POLL_SECONDS;

  return {
    idleSuspendMinutes,
    // A zero poll interval would spin; treat it as "use the default".
    clientPollSeconds: clientPollSeconds > 0 ? clientPollSeconds : DEFAULT_CLIENT_POLL_SECONDS,
  };
}
