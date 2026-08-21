/**
 * Session endpoint - the private channel a CLI process uses to run a tool
 * inside this MCP session, against the connections this session already holds.
 *
 * A unix socket, not a TCP port. The tools reachable here evaluate JavaScript
 * in the session's browser and read its cookies; a web page can reach a
 * localhost port and cannot open a socket file, so the address type is the
 * access control.
 *
 * On Windows the address is a named pipe. Node's `net` API is identical for
 * both, and libuv rejects remote clients, but a pipe carries no mode bits -
 * the 0600 guarantee holds on POSIX only.
 */

import { createServer, type Server, type Socket } from 'net';
import { promises as fs, existsSync, readFileSync, readdirSync, unlinkSync, chmodSync } from 'fs';
import { join } from 'path';
import { getOutputPath, getTempPath } from './helpers/paths.js';
import { isProcessAlive } from './helpers/process-liveness.js';

/** What a CLI needs to recognise this session and reach it. */
export interface SessionRecord {
  pid: number;
  ppid: number;
  cwd: string;
  sessionId?: string;
  shortId?: string;
  /** Socket path or named pipe this session listens on. */
  address: string;
  startedAt: number;
}

/** One request on the socket: run this tool with these arguments. */
export interface EndpointRequest {
  tool: string;
  args: Record<string, unknown>;
}

/** The reply. `response` is the tool's own MCP response, content and _meta
 *  intact, so a CLI prints exactly what an MCP client would receive. */
export interface EndpointReply {
  ok: boolean;
  response?: unknown;
  error?: string;
}

export interface SessionEndpoint {
  address: string;
  presencePath: string;
  /** Rewrite the presence record - the short id arrives after the listener
   *  starts, and a CLI matching on it needs the current value. */
  refresh(identity: Partial<SessionRecord>): Promise<void>;
  close(): Promise<void>;
}

/** sun_path is 104 bytes on macOS and 108 on Linux; a path near that length
 *  fails to bind with ENAMETOOLONG. */
const MAX_SOCKET_PATH = 96;

/** Owned by this feature alone: `~/.devharness/sessions/` already holds the
 *  supervisor presence records `server-claims.ts` writes, under a different
 *  schema. */
export function getEndpointsDir(): string {
  return getOutputPath('endpoints', { global: true });
}

export function getPresencePath(pid: number): string {
  return join(getEndpointsDir(), `${pid}.json`);
}

/** The listen address for `pid`: a named pipe on Windows, a socket file under
 *  the sessions directory otherwise, falling back to the temp directory when
 *  that path would exceed the sockaddr limit. */
export function getEndpointAddress(pid: number): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\devharness-${pid}`;
  }
  const preferred = join(getEndpointsDir(), `${pid}.sock`);
  if (preferred.length <= MAX_SOCKET_PATH) return preferred;
  return getTempPath(`session-${pid}.sock`);
}

/** Every session record on disk, newest first. Records naming a dead process
 *  are dropped and their files removed: a killed session leaves both behind,
 *  and a CLI matching against one would dial a socket nothing is listening on. */
export function listSessionRecords(): SessionRecord[] {
  let entries: string[];
  try {
    entries = readdirSync(getEndpointsDir());
  } catch {
    return [];
  }

  const records: SessionRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const path = join(getEndpointsDir(), entry);
    let record: SessionRecord;
    try {
      record = JSON.parse(readFileSync(path, 'utf-8')) as SessionRecord;
    } catch {
      continue;
    }
    if (!record?.pid || !record.address) continue;

    if (!isProcessAlive(record.pid)) {
      try { unlinkSync(path); } catch { /* another process swept it first */ }
      if (process.platform !== 'win32') {
        try { unlinkSync(record.address); } catch { /* already gone */ }
      }
      continue;
    }
    records.push(record);
  }

  return records.sort((a, b) => b.startedAt - a.startedAt);
}

export interface StartSessionEndpointOptions {
  executeToolCall: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
  identity: Omit<SessionRecord, 'address' | 'startedAt'>;
}

/**
 * Listen for CLI tool calls and publish the presence record that locates this
 * session. Returns null when the listener cannot bind - the MCP session keeps
 * working, the CLI just cannot reach it.
 */
export async function startSessionEndpoint(
  options: StartSessionEndpointOptions
): Promise<SessionEndpoint | null> {
  const pid = options.identity.pid;
  const address = getEndpointAddress(pid);
  const presencePath = getPresencePath(pid);

  await fs.mkdir(getEndpointsDir(), { recursive: true });

  // A previous process with this pid, or this process before a crash, leaves a
  // socket file that bind() refuses. Nothing is listening on it - the pid check
  // in listSessionRecords already proved that for every record we keep.
  if (process.platform !== 'win32' && existsSync(address)) {
    try { unlinkSync(address); } catch { /* bind will report it */ }
  }

  const server: Server = createServer((socket: Socket) => {
    handleConnection(socket, options.executeToolCall);
  });

  const bound = await new Promise<boolean>((resolve) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      console.error(`[devharness] session endpoint failed to listen on ${address}: ${error.message}`);
      resolve(false);
    });
    server.listen(address, () => resolve(true));
  });

  if (!bound) return null;

  // Owner-only. On Windows the pipe carries no mode bits, so this is skipped
  // and another account on the machine may be able to connect.
  if (process.platform !== 'win32') {
    try { chmodSync(address, 0o600); } catch { /* best effort */ }
  }

  const record: SessionRecord = {
    ...options.identity,
    address,
    startedAt: Date.now(),
  };
  await writeRecord(presencePath, record);

  return {
    address,
    presencePath,
    async refresh(identity: Partial<SessionRecord>): Promise<void> {
      Object.assign(record, identity);
      await writeRecord(presencePath, record);
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try { unlinkSync(presencePath); } catch { /* already gone */ }
      if (process.platform !== 'win32') {
        try { unlinkSync(address); } catch { /* already gone */ }
      }
    },
  };
}

async function writeRecord(path: string, record: SessionRecord): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(record), { mode: 0o600 });
  await fs.rename(temp, path);
}

/**
 * One request per connection: a single JSON line in, a single JSON line out,
 * then close. A tool response carries no framing of its own, so the newline is
 * what tells the caller the reply is complete.
 */
function handleConnection(
  socket: Socket,
  executeToolCall: StartSessionEndpointOptions['executeToolCall']
): void {
  let buffer = '';
  let handled = false;

  socket.setEncoding('utf-8');
  socket.on('error', () => { /* the caller went away mid-call */ });

  socket.on('data', (chunk: string) => {
    if (handled) return;
    buffer += chunk;
    const newline = buffer.indexOf('\n');
    if (newline === -1) return;
    handled = true;

    const line = buffer.slice(0, newline);
    void respond(socket, line, executeToolCall);
  });
}

async function respond(
  socket: Socket,
  line: string,
  executeToolCall: StartSessionEndpointOptions['executeToolCall']
): Promise<void> {
  const send = (reply: EndpointReply) => {
    socket.end(JSON.stringify(reply) + '\n');
  };

  let request: EndpointRequest;
  try {
    request = JSON.parse(line) as EndpointRequest;
  } catch {
    send({ ok: false, error: 'Request was not a single line of JSON' });
    return;
  }

  if (!request?.tool || typeof request.tool !== 'string') {
    send({ ok: false, error: 'Request needs a tool name' });
    return;
  }

  try {
    const response = await executeToolCall(request.tool, request.args ?? {});
    send({ ok: true, response });
  } catch (error: any) {
    // executeToolCall throws ToolError for an isError response; its payload is
    // the response itself, which the caller renders like any other.
    if (error?.response) {
      send({ ok: true, response: error.response });
      return;
    }
    send({ ok: false, error: error?.message || String(error) });
  }
}
