// @vitest-environment node
// (node, not happy-dom: this test needs a real http server and Node's own
// fetch/AbortSignal so the socket teardown is observable.)
/**
 * Cancellation of the `request` tool (#110).
 *
 * `request` with destination "node" is the ONE genuinely cancellable handler
 * in the codebase: the external signal is composed into the controller passed
 * to fetch, so aborting closes the socket rather than merely abandoning the
 * await. These tests prove that from the SERVER's side - a local server that
 * never responds, and an assertion that the request's own 'aborted'/'close'
 * event fires. Asserting only that the handler's promise rejected would pass
 * just as happily against a fake "stop waiting" implementation.
 */
import { describe, it, expect } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequestTools } from './request-tools.js';
import { isAbortError } from '../utils/abort.js';

/**
 * A server that accepts the request and then NEVER responds, exposing a
 * promise that settles when the client's socket goes away.
 */
async function makeHangingServer() {
  let onRequestReceived: () => void;
  const requestReceived = new Promise<void>((resolve) => { onRequestReceived = resolve; });

  let onClientGone: (how: string) => void;
  const clientGone = new Promise<string>((resolve) => { onClientGone = resolve; });

  const server = http.createServer((req) => {
    // 'aborted' (client abandoned mid-request) or 'close' (socket torn down)
    req.on('aborted', () => onClientGone('aborted'));
    req.on('close', () => onClientGone('close'));
    onRequestReceived();
    // Deliberately never write a response.
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/hang`,
    requestReceived,
    clientGone,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

function makeRequest() {
  // destination 'node' never touches a connection, so the resolver is a stub.
  const { request } = createRequestTools(async () => null);
  return request;
}

describe('request cancellation (destination: node)', () => {
  it('closes the socket when the external signal aborts mid-flight (server observes it)', async () => {
    const server = await makeHangingServer();
    const request = makeRequest();
    const controller = new AbortController();

    try {
      // Reify the outcome immediately: we abort and then await the SERVER
      // first, so the handler's rejection must already be handled or Node
      // reports it as an unhandled rejection.
      const settled = request.handler(
        // timeoutMs deliberately far larger than the test: if the socket only
        // closed because of the tool's own timeout this test would hang, not pass.
        { url: server.url, method: 'GET', destination: 'node', timeoutMs: 120_000 } as any,
        controller.signal
      ).then(
        (value: any) => ({ ok: true as const, value }),
        (err: any) => ({ ok: false as const, err })
      );

      // Only abort once the server has actually got the request, so what we
      // observe is a cancelled IN-FLIGHT request, not a request never sent.
      await server.requestReceived;
      controller.abort();

      // The server side is the real proof: the socket went away.
      const how = await server.clientGone;
      expect(['aborted', 'close']).toContain(how);

      // And the handler surfaces a cancellation, not a request failure and
      // certainly not a "Timed out after 120000ms" (the pre-fix behaviour
      // mapped every AbortError to the timeout message).
      const outcome = await settled;
      expect(outcome.ok).toBe(false);
      expect(isAbortError((outcome as any).err)).toBe(true);
      expect(String((outcome as any).err?.message)).not.toContain('Timed out');
    } finally {
      await server.close();
    }
  });

  it('does not send the request at all when the signal is already aborted', async () => {
    const server = await makeHangingServer();
    const request = makeRequest();
    const controller = new AbortController();
    controller.abort();

    let received = false;
    server.requestReceived.then(() => { received = true; });

    try {
      await expect(
        request.handler(
          { url: server.url, method: 'GET', destination: 'node', timeoutMs: 120_000 } as any,
          controller.signal
        )
      ).rejects.toSatisfy((err: any) => isAbortError(err));

      // Give the event loop a turn - if a socket had been opened, the server
      // handler would have run by now.
      await new Promise((r) => setTimeout(r, 50));
      expect(received).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('still reports its own timeout as a timeout, not as a cancellation', async () => {
    const server = await makeHangingServer();
    const request = makeRequest();

    try {
      // No external signal: the tool's own timeoutMs must keep behaving as
      // before - an isError response saying it timed out.
      const result: any = await request.handler(
        { url: server.url, method: 'GET', destination: 'node', timeoutMs: 150 } as any,
        undefined
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Timed out after 150ms');
    } finally {
      await server.close();
    }
  });

  it('a timeout while an unrelated signal exists but has NOT aborted is still a timeout', async () => {
    const server = await makeHangingServer();
    const request = makeRequest();
    const controller = new AbortController(); // never aborted

    try {
      const result: any = await request.handler(
        { url: server.url, method: 'GET', destination: 'node', timeoutMs: 150 } as any,
        controller.signal
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Timed out after 150ms');
    } finally {
      await server.close();
    }
  });
});
