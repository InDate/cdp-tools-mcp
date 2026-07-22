/**
 * Newline-delimited JSON message framing - the exact wire format
 * @modelcontextprotocol/sdk uses for stdio (see its own ReadBuffer in
 * dist/esm/shared/stdio.js: messages are `JSON.stringify(message) + '\n'`,
 * split on the first '\n', with a trailing '\r' tolerated on read).
 *
 * Buffers as raw bytes (not strings) so a multi-byte UTF-8 character split
 * across two chunks is never corrupted.
 */
export class NdjsonReader {
  private buffer: Buffer | undefined;

  /** Feed a raw chunk of bytes read from a stream. */
  push(chunk: Buffer): void {
    this.buffer = this.buffer ? Buffer.concat([this.buffer, chunk]) : chunk;
  }

  /**
   * Pull the next complete line, if any, as a raw string (not yet parsed).
   * Returns undefined if no complete line is buffered yet.
   */
  readLine(): string | undefined {
    if (!this.buffer) {
      return undefined;
    }
    const index = this.buffer.indexOf('\n');
    if (index === -1) {
      return undefined;
    }
    const line = this.buffer.toString('utf8', 0, index).replace(/\r$/, '');
    this.buffer = this.buffer.subarray(index + 1);
    return line;
  }

  /** Drain and return every complete line currently buffered, in order. */
  readAllLines(): string[] {
    const lines: string[] = [];
    let line: string | undefined;
    while ((line = this.readLine()) !== undefined) {
      lines.push(line);
    }
    return lines;
  }
}

/** JSON-RPC 2.0 message shape, classified structurally (no schema validation). */
export type ParsedMessage =
  | { kind: 'request'; id: string | number; method: string; raw: unknown }
  | { kind: 'notification'; method: string; raw: unknown }
  | { kind: 'response'; id: string | number; raw: unknown }
  | { kind: 'unparseable'; raw: string };

/**
 * Classify a raw NDJSON line. Never throws - an unparseable or
 * unrecognizable line is still forwarded (as 'unparseable'), since the
 * supervisor's job is to proxy, not to police the protocol.
 */
export function classifyLine(line: string): ParsedMessage {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { kind: 'unparseable', raw: line };
  }

  if (typeof value !== 'object' || value === null) {
    return { kind: 'unparseable', raw: line };
  }

  const obj = value as Record<string, unknown>;
  const hasId = 'id' in obj && (typeof obj.id === 'string' || typeof obj.id === 'number');
  const hasMethod = 'method' in obj && typeof obj.method === 'string';

  if (hasId && hasMethod) {
    return { kind: 'request', id: obj.id as string | number, method: obj.method as string, raw: value };
  }
  if (hasMethod) {
    return { kind: 'notification', method: obj.method as string, raw: value };
  }
  if (hasId) {
    return { kind: 'response', id: obj.id as string | number, raw: value };
  }
  return { kind: 'unparseable', raw: line };
}

export function serializeMessage(message: unknown): string {
  return JSON.stringify(message) + '\n';
}
