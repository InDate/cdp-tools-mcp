/**
 * Spawns and kills the real MCP server as a child process.
 *
 * Mirrors the SIGTERM(process-group)->grace-period->SIGKILL(process-group)
 * escalation pattern used elsewhere in this repo (src/runners/native-runner.ts
 * `stop()`), but - unlike that runner, which only ever holds a bare pid it
 * may have recovered across a process restart - this always has a live
 * ChildProcess handle, so completion is driven by Node's own 'exit' event
 * rather than external process.kill(pid, 0) polling. That avoids any race
 * between two independent "is it dead yet" mechanisms.
 *
 * Deliberately does NOT call `.unref()` on the spawned child (unlike
 * native-runner.ts, whose children are meant to outlive it) - the child here
 * must never outlive this supervisor.
 */
import { spawn, type ChildProcess } from 'child_process';

export interface ChildManagerOptions {
  execPath: string;
  scriptPath: string;
  extraArgs: string[];
  cwd: string;
  killGraceMs?: number;
}

export interface ChildExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface ChildStreams {
  stdout: NodeJS.ReadableStream;
  stdin: NodeJS.WritableStream;
}

export class ChildManager {
  private child: ChildProcess | null = null;
  private onExitCallback: ((info: ChildExitInfo) => void) | null = null;
  private readonly killGraceMs: number;

  constructor(private readonly opts: ChildManagerOptions) {
    this.killGraceMs = opts.killGraceMs ?? 3000;
  }

  /** Registered once; fires for every child this instance ever spawns. */
  onExit(callback: (info: ChildExitInfo) => void): void {
    this.onExitCallback = callback;
  }

  spawn(): ChildStreams {
    const child = spawn(this.opts.execPath, [this.opts.scriptPath, ...this.opts.extraArgs], {
      cwd: this.opts.cwd,
      stdio: ['pipe', 'pipe', 'inherit'],
      detached: true,
    });
    this.child = child;

    child.on('exit', (code, signal) => {
      if (this.child === child) {
        this.child = null;
      }
      this.onExitCallback?.({ code, signal });
    });

    if (!child.stdout || !child.stdin) {
      throw new Error('Child process did not provide piped stdio streams');
    }
    return { stdout: child.stdout, stdin: child.stdin };
  }

  isRunning(): boolean {
    return this.child !== null;
  }

  /** Kill the current child (if any) and resolve once it has actually exited. */
  async kill(): Promise<void> {
    const child = this.child;
    if (!child || child.pid === undefined) {
      return;
    }
    const pid = child.pid;

    await new Promise<void>((resolve) => {
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout>;

      const onExit = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        resolve();
      };
      child.once('exit', onExit);

      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // Already dead
        }
      }

      killTimer = setTimeout(() => {
        if (settled) return;
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // Already dead
          }
        }
        // Deliberately don't resolve here - wait for the real 'exit' event
        // above so we never consider kill() done before the process is gone.
      }, this.killGraceMs);
    });
  }
}
