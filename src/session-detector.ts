/**
 * Session Detector
 *
 * Tracks Claude Code sessions and agents by watching .jsonl files.
 *
 * HOW IT WORKS:
 * 1. Starts monitoring ALL .jsonl files immediately when created
 * 2. Every tool response includes "pid:XXXXX" (added in index.ts)
 * 3. After first tool, verify(pid) sets the PID to filter for
 * 4. Detects session changes, agent activity, and tracks entry counts
 *
 * STREAMS:
 * - session$: Emits when main session changes (PID in different {uuid}.jsonl)
 * - agents$: Emits when agent list changes (PID in agent-{uuid}.jsonl files)
 * - entryCount$: Emits running count of entries in current session file
 */

import { Observable, Subject, BehaviorSubject } from 'rxjs';
import { filter, takeUntil } from 'rxjs/operators';
import { watch, readdirSync, statSync, openSync, readSync, closeSync, type FSWatcher } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { debugLog } from './debug-logger.js';

export interface SessionInfo {
  sessionId: string;
  shortId: string;
  sessionFile: string;
  detectedAt: number;
}

export interface AgentInfo {
  agentId: string;
  shortId: string;
  agentFile: string;
  startedAt: number;
}

export interface SessionState {
  mainSession: SessionInfo | null;
  activeAgents: AgentInfo[];
  entryCount: number;
}

interface FileChange {
  filePath: string;
  fileName: string;
  content: string;
  lineCount: number;
  isAgent: boolean;
  sessionId: string;
}

export interface SessionDetector {
  session$: Observable<SessionInfo>;
  agents$: Observable<AgentInfo[]>;
  entryCount$: Observable<number>;
  getState(): SessionState;
  verify(pid: number): void;
  stop(): void;
}

/**
 * Create a session detector that tracks sessions and agents
 */
export function createSessionDetector(cwd: string): SessionDetector {
  const projectPath = cwd.replace(/\//g, '-');
  const claudeProjectDir = join(homedir(), '.claude', 'projects', projectPath);

  const stop$ = new Subject<void>();
  const changes$ = new Subject<FileChange>();

  // State
  let pidPattern: string | null = null;
  let currentSessionFile: string | null = null;
  const activeAgents = new Map<string, AgentInfo>();

  // Output subjects
  const session$ = new Subject<SessionInfo>();
  const agents$ = new BehaviorSubject<AgentInfo[]>([]);
  const entryCount$ = new BehaviorSubject<number>(0);

  // File watching state
  const filePositions = new Map<string, number>();
  const watchers = new Map<string, FSWatcher>();

  // ============ File Watching ============

  const readNewContent = (filePath: string): { content: string; lineCount: number } | null => {
    try {
      const stats = statSync(filePath);
      const lastPos = filePositions.get(filePath) ?? stats.size;

      if (stats.size <= lastPos) {
        filePositions.set(filePath, stats.size);
        return null;
      }

      const readSize = stats.size - lastPos;
      const fd = openSync(filePath, 'r');
      const buffer = Buffer.alloc(readSize);

      try {
        readSync(fd, buffer, 0, readSize, lastPos);
      } finally {
        closeSync(fd);
      }

      filePositions.set(filePath, stats.size);
      const content = buffer.toString('utf-8');
      const lineCount = (content.match(/\n/g) || []).length;

      return { content, lineCount };
    } catch {
      return null;
    }
  };

  const extractId = (fileName: string): string => {
    return fileName.replace('.jsonl', '').replace(/^agent-/, '');
  };

  const watchFile = (filePath: string): void => {
    if (watchers.has(filePath)) return;

    const fileName = filePath.split('/').pop() || '';

    try {
      const stats = statSync(filePath);
      filePositions.set(filePath, stats.size);
    } catch {
      return;
    }

    const watcher = watch(filePath, { persistent: false }, (eventType) => {
      if (eventType !== 'change') return;

      const result = readNewContent(filePath);
      if (!result || result.content.length === 0) return;

      const isAgent = fileName.startsWith('agent-');
      const sessionId = extractId(fileName);

      changes$.next({
        filePath,
        fileName,
        content: result.content,
        lineCount: result.lineCount,
        isAgent,
        sessionId,
      });
    });

    watchers.set(filePath, watcher);
  };

  const watchDirectory = (): void => {
    try {
      const files = readdirSync(claudeProjectDir).filter(f =>
        f.endsWith('.jsonl') &&
        f !== '00000000-0000-0000-0000-000000000000.jsonl'
      );

      debugLog('session-detector', `[monitor] Watching ${files.length} files in ${claudeProjectDir}`);

      for (const file of files) {
        watchFile(join(claudeProjectDir, file));
      }

      const dirWatcher = watch(claudeProjectDir, { persistent: false }, (eventType, filename) => {
        if (eventType === 'rename' && filename?.endsWith('.jsonl')) {
          const filePath = join(claudeProjectDir, filename);
          if (!watchers.has(filePath)) {
            debugLog('session-detector', `[monitor] New file: ${filename}`);
            setTimeout(() => watchFile(filePath), 50);
          }
        }
      });

      watchers.set(claudeProjectDir, dirWatcher);
    } catch {
      setTimeout(watchDirectory, 1000);
    }
  };

  // ============ Stream Processing ============

  const processMonitor = (change: FileChange): void => {
    if (!pidPattern) {
      debugLog('session-detector', `[monitor] Activity (awaiting PID): ${change.fileName}`);
      return;
    }

    if (!change.content.includes(pidPattern)) return;

    if (change.isAgent) {
      if (!activeAgents.has(change.sessionId)) {
        debugLog('session-detector', `[monitor] New agent: ${change.sessionId.substring(0, 8)}`);
        const agent: AgentInfo = {
          agentId: change.sessionId,
          shortId: change.sessionId.substring(0, 8),
          agentFile: change.filePath,
          startedAt: Date.now(),
        };
        activeAgents.set(change.sessionId, agent);
        agents$.next(Array.from(activeAgents.values()));
      }
    } else {
      if (change.filePath !== currentSessionFile) {
        const isInitialDetection = currentSessionFile === null;
        const hadAgents = activeAgents.size > 0;

        activeAgents.clear();
        agents$.next([]);
        entryCount$.next(0);

        currentSessionFile = change.filePath;

        if (isInitialDetection) {
          debugLog('session-detector', `[monitor] Session verified: ${change.sessionId.substring(0, 8)}`);
        } else {
          debugLog('session-detector', `[monitor] Session changed: ${change.sessionId.substring(0, 8)}${hadAgents ? ' (agents cleared)' : ''}`);
        }

        session$.next({
          sessionId: change.sessionId,
          shortId: change.sessionId.substring(0, 8),
          sessionFile: change.filePath,
          detectedAt: Date.now(),
        });
      }
    }
  };

  const processSession = (change: FileChange): void => {
    if (change.filePath !== currentSessionFile) return;

    entryCount$.next(entryCount$.value + change.lineCount);
  };

  // ============ Start Monitoring ============

  debugLog('session-detector', `[monitor] Starting`);
  watchDirectory();

  // Monitor stream - all file changes
  changes$.pipe(takeUntil(stop$)).subscribe(processMonitor);

  // Session stream - only our verified session
  changes$.pipe(
    takeUntil(stop$),
    filter(c => !c.isAgent && currentSessionFile !== null && c.filePath === currentSessionFile)
  ).subscribe(processSession);

  // ============ Public API ============

  const verify = (pid: number): void => {
    if (pidPattern) return;

    pidPattern = `pid:${pid}`;
    debugLog('session-detector', `[monitor] Now filtering for PID ${pid}`);
  };

  const stop = (): void => {
    debugLog('session-detector', `[monitor] Stopping`);
    stop$.next();
    stop$.complete();

    for (const watcher of watchers.values()) {
      watcher.close();
    }
    watchers.clear();
    filePositions.clear();

    changes$.complete();
    session$.complete();
    agents$.complete();
    entryCount$.complete();
  };

  const getState = (): SessionState => {
    let mainSession: SessionInfo | null = null;

    if (currentSessionFile) {
      const fileName = currentSessionFile.split('/').pop() || '';
      const sessionId = fileName.replace('.jsonl', '');
      mainSession = {
        sessionId,
        shortId: sessionId.substring(0, 8),
        sessionFile: currentSessionFile,
        detectedAt: Date.now(),
      };
    }

    return {
      mainSession,
      activeAgents: Array.from(activeAgents.values()),
      entryCount: entryCount$.value,
    };
  };

  return {
    session$: session$.asObservable(),
    agents$: agents$.asObservable(),
    entryCount$: entryCount$.asObservable(),
    getState,
    verify,
    stop,
  };
}
