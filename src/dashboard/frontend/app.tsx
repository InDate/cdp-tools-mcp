/** @jsxImportSource preact */
import { render } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';

interface ConnectionInfo {
  reference: string;
  type: 'chrome' | 'node' | 'unknown';
  state: 'active' | 'idle' | 'paused';
  createdAt: number;
  lastActivityAt: number;
}

interface ActionInfo {
  tool: string;
  timestamp: number;
  connectionReference?: string;
}

interface SessionInfo {
  sessionId: string;
  pid: number;
  cwd: string;
  startedAt: number;
  lastHeartbeat: number;
  connections: ConnectionInfo[];
  lastAction?: ActionInfo;
  sessionEntryCount?: number;
  allPids?: number[];
}

interface ProjectInfo {
  cwd: string;
  sessions: SessionInfo[];
  issues: {
    bugs: number;
    features: number;
  };
}

interface DashboardState {
  projects: ProjectInfo[];
  hubPid: number;
  hubPort: number;
  hubStartedAt: number;
}

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatUptime(startedAt: number): string {
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours < 24) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function formatSessionId(sessionId: string | undefined): string {
  if (!sessionId) return 'unknown';
  // Show first segment of UUID (e.g., "0ae027fe" from "0ae027fe-1234-...")
  const firstSegment = sessionId.split('-')[0];
  return firstSegment || sessionId.slice(0, 8);
}

function StateLabel({ state }: { state: string }) {
  const className = `state state-${state}`;
  return <span className={className}>{state}</span>;
}

function IssuesDisplay({ bugs, features }: { bugs: number; features: number }) {
  if (bugs === 0 && features === 0) {
    return <span className="no-issues">-</span>;
  }
  return (
    <span className="issues-display">
      {bugs > 0 && <span className="bug-count">{bugs} 🐛</span>}
      {features > 0 && <span className="feature-count">{features} ✨</span>}
    </span>
  );
}

function ConnectionRow({ conn, isLast }: { conn: ConnectionInfo; isLast: boolean }) {
  const prefix = isLast ? '└─' : '├─';
  return (
    <tr className="connection-row">
      <td className="indent-2">
        <span className="tree-line">{prefix}</span> {conn.reference}
      </td>
      <td>{formatUptime(conn.createdAt)}</td>
      <td className="time-ago">{formatTimeAgo(conn.lastActivityAt)}</td>
      <td><StateLabel state={conn.state} /></td>
      <td></td>
      <td></td>
    </tr>
  );
}

function SessionRow({ session, expanded, onToggle, isLast }: {
  session: SessionInfo;
  expanded: boolean;
  onToggle: () => void;
  isLast: boolean;
}) {
  const hasConnections = session.connections.length > 0;
  const prefix = isLast ? '└─' : '├─';
  const mcpCount = session.allPids?.length || 1;
  const hasMultipleMcps = mcpCount > 1;

  // Determine session state from connections or lastAction
  const getSessionState = () => {
    if (session.connections.length > 0) {
      if (session.connections.some(c => c.state === 'paused')) return 'paused';
      if (session.connections.some(c => c.state === 'active')) return 'active';
      return 'idle';
    }
    // No connections - check last action time
    if (session.lastAction) {
      const timeSinceAction = Date.now() - session.lastAction.timestamp;
      if (timeSinceAction < 30000) return 'active';
    }
    return 'idle';
  };

  return (
    <>
      <tr className={`session-row ${expanded ? 'expanded' : ''}`} onClick={onToggle}>
        <td className="indent-1">
          <span className="tree-line">{prefix}</span>
          {hasConnections && <span className="expand-icon">{expanded ? ' ▼' : ' ▶'}</span>}
          {' '}{formatSessionId(session.sessionId)}
          {hasMultipleMcps && (
            <span className="mcp-count" title={`PIDs: ${session.allPids?.join(', ')}`}>
              {mcpCount} MCP
            </span>
          )}
        </td>
        <td>{formatUptime(session.startedAt)}</td>
        <td className="time-ago">
          {session.lastAction
            ? `${session.lastAction.tool} (${formatTimeAgo(session.lastAction.timestamp)})`
            : '-'
          }
        </td>
        <td><StateLabel state={getSessionState()} /></td>
        <td className="entry-count">
          {session.sessionEntryCount !== undefined ? `+${session.sessionEntryCount}` : '-'}
        </td>
        <td></td>
      </tr>
      {expanded && session.connections.map((conn, idx) => (
        <ConnectionRow
          key={conn.reference}
          conn={conn}
          isLast={idx === session.connections.length - 1}
        />
      ))}
    </>
  );
}

function ProjectRow({ project, defaultExpanded }: { project: ProjectInfo; defaultExpanded: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(() => {
    // Default expand sessions with connections
    const set = new Set<string>();
    project.sessions.forEach(s => {
      if (s.connections.length > 0) {
        set.add(s.sessionId);
      }
    });
    return set;
  });

  const toggleSession = (sessionId: string) => {
    const newSet = new Set(expandedSessions);
    if (newSet.has(sessionId)) {
      newSet.delete(sessionId);
    } else {
      newSet.add(sessionId);
    }
    setExpandedSessions(newSet);
  };

  return (
    <>
      <tr className={`project-row ${expanded ? 'expanded' : ''}`} onClick={() => setExpanded(!expanded)}>
        <td>
          <span className="expand-icon">{expanded ? '▼' : '▶'}</span>
          {' '}{project.cwd}
        </td>
        <td></td>
        <td></td>
        <td></td>
        <td></td>
        <td><IssuesDisplay bugs={project.issues.bugs} features={project.issues.features} /></td>
      </tr>
      {expanded && project.sessions.map((session, idx) => (
        <SessionRow
          key={session.sessionId}
          session={session}
          expanded={expandedSessions.has(session.sessionId)}
          onToggle={() => toggleSession(session.sessionId)}
          isLast={idx === project.sessions.length - 1}
        />
      ))}
    </>
  );
}

function Dashboard() {
  const [state, setState] = useState<DashboardState | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    const connect = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}`);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'state') {
            setState(message.data);
          } else if (message.type === 'update' || message.type === 'session_added') {
            setState(prev => {
              if (!prev) return prev;
              const session = message.data as SessionInfo;
              const newProjects = [...prev.projects];

              let projectIndex = newProjects.findIndex(p => p.cwd === session.cwd);
              if (projectIndex === -1) {
                newProjects.push({
                  cwd: session.cwd,
                  sessions: [session],
                  issues: { bugs: 0, features: 0 },
                });
              } else {
                const project = { ...newProjects[projectIndex] };
                const sessionIndex = project.sessions.findIndex(s => s.sessionId === session.sessionId);
                if (sessionIndex === -1) {
                  project.sessions = [...project.sessions, session];
                } else {
                  project.sessions = [...project.sessions];
                  project.sessions[sessionIndex] = session;
                }
                newProjects[projectIndex] = project;
              }

              return { ...prev, projects: newProjects };
            });
          } else if (message.type === 'session_removed') {
            setState(prev => {
              if (!prev) return prev;
              const { pid } = message.data;
              const newProjects = prev.projects.map(project => ({
                ...project,
                sessions: project.sessions.filter(s => s.pid !== pid),
              })).filter(p => p.sessions.length > 0);

              return { ...prev, projects: newProjects };
            });
          }
        } catch (err) {
          console.error('Failed to parse WebSocket message:', err);
        }
      };

      ws.onclose = () => {
        setConnected(false);
        wsRef.current = null;
        reconnectTimeoutRef.current = window.setTimeout(connect, 2000);
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, []);

  // Update status badge
  useEffect(() => {
    const badge = document.getElementById('status-badge');
    if (badge) {
      badge.className = connected ? 'connected-badge' : 'connected-badge disconnected-badge';
    }
  }, [connected]);

  // Auto-refresh times every second
  useEffect(() => {
    const interval = setInterval(() => {
      setState(prev => prev ? { ...prev } : prev);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  if (!state) {
    return <div className="no-sessions">Connecting to dashboard...</div>;
  }

  if (state.projects.length === 0) {
    return (
      <div className="no-sessions">
        <p>No active sessions</p>
        <p style={{ fontSize: '0.9rem', marginTop: '10px' }}>
          Sessions will appear when MCP servers connect with the dashboard enabled
        </p>
      </div>
    );
  }

  return (
    <table>
      <thead>
        <tr>
          <th>Project / Session / Connection</th>
          <th>Uptime</th>
          <th>Last Action</th>
          <th>State</th>
          <th>Entries</th>
          <th>Issues</th>
        </tr>
      </thead>
      <tbody>
        {state.projects.map(project => (
          <ProjectRow key={project.cwd} project={project} defaultExpanded={true} />
        ))}
      </tbody>
    </table>
  );
}

// Mount the app
const contentEl = document.getElementById('content');
if (contentEl) {
  render(<Dashboard />, contentEl);
}
