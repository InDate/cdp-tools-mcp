/**
 * Network Monitor
 * Tracks network requests from the browser
 */

import { Page, HTTPRequest, HTTPResponse } from 'puppeteer-core';

export interface StoredNetworkRequest {
  id: string;
  url: string;
  method: string;
  resourceType: string;
  requestHeaders: Record<string, string>;
  postData?: string;
  response?: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body?: string;
    bodySize?: number;
    bodyTokens?: number;
    bodyPath?: string;
  };
  timing?: {
    startTime: number;
    endTime?: number;
    duration?: number;
  };
  failed: boolean;
  errorText?: string;
}

/**
 * One WebSocket's life. Puppeteer's page events do not cover WebSockets, so
 * these come from the raw CDP Network domain.
 *
 * A socket that opened and is still open is healthy. One that CLOSED during a
 * run is the interesting case: an app whose reads come over a socket can keep
 * rendering the last synced snapshot afterwards and pass every assertion.
 */
export interface StoredWebSocket {
  id: string;
  url: string;
  openedAt: number;
  closedAt?: number;
  /** Frame-level protocol errors, which do not necessarily close the socket. */
  errors: string[];
  /**
   * CDP target type that owns the socket - 'page', or a worker type such as
   * 'worker'/'shared_worker'/'service_worker'. An app that syncs from a worker
   * has its real transport here, not on the page.
   */
  target: string;
  /** CDP session the socket was seen on; scopes its id and its lifetime. */
  sessionId: string;
  /**
   * Its target is gone, so the close came with the teardown rather than from
   * the transport failing. Decided when the socket is read, not when it closed:
   * a close event and its target's detach race, and blaming whichever arrived
   * first made healthy navigations and identity changes look like drops.
   */
  closedWithTarget?: boolean;
  /**
   * The page sent a close frame - it hung up on purpose (an app dropping a
   * socket on sign-out or an identity change), rather than losing the
   * transport. `Network.webSocketClosed` carries no close code, so the sent
   * opcode-8 frame is the only CDP-visible signal of intent.
   */
  clientClosed?: boolean;
}

export class NetworkMonitor {
  private sockets: Map<string, StoredWebSocket> = new Map();
  /**
   * Sessions still attached. Whether a socket's target is gone has to be
   * answered when the question is asked, not when the socket closed: the close
   * event and the target's detach race, and if the close lands first the socket
   * looks self-inflicted when its worker was actually being torn down.
   */
  private liveSessions: Set<string> = new Set();
  private wsClient: any = null;
  private requests: Map<string, StoredNetworkRequest> = new Map();
  private requestIdCounter = 0;
  private maxRequests = 1000;
  private isMonitoring = false;
  private lastActivityTime: number = Date.now();

  /**
   * Start monitoring network requests on a page
   */
  startMonitoring(page: Page): void {
    // Remove any existing listeners first to avoid duplicates
    page.removeAllListeners('request');
    page.removeAllListeners('response');
    page.removeAllListeners('requestfailed');

    // Attach network listeners
    page.on('request', (request: HTTPRequest) => {
      this.onRequest(request);
    });

    page.on('response', async (response: HTTPResponse) => {
      await this.onResponse(response);
    });

    page.on('requestfailed', (request: HTTPRequest) => {
      this.onRequestFailed(request);
    });

    // WebSocket lifecycle rides the CDP Network domain - puppeteer surfaces no
    // page event for it. Failing to attach must not break HTTP monitoring.
    void this.startSocketMonitoring(page);

    this.isMonitoring = true;
  }

  /** Subscribe to the CDP WebSocket lifecycle events for this page and its workers. */
  private async startSocketMonitoring(page: Page): Promise<void> {
    // Re-entered after every navigation (page-tools restartMonitoring). Each
    // entry opens a session that auto-attaches to the page's workers, so
    // without dropping the previous one they accumulate and every stacked
    // session records the same physical socket again - inflating the counts a
    // run's health verdict is computed from.
    const previous = this.wsClient;
    this.wsClient = null;
    if (previous) {
      try { await previous.detach(); } catch { /* already gone with its target */ }
    }
    try {
      const client: any = await (page as any).createCDPSession();
      this.wsClient = client;
      await client.send('Network.enable');
      // The page's own session outlives every navigation, so its sockets are
      // judged on their own close events, never as target teardown.
      this.liveSessions.add('page');
      this.bindSocketEvents(client, 'page', 'page');

      // A socket opened inside a Web Worker belongs to that worker's target and
      // emits nothing on the page session, so each worker needs its own session
      // with Network enabled. waitForDebuggerOnStart holds the worker before its
      // first line runs - otherwise a socket opened at worker boot is missed.
      client.on('Target.attachedToTarget', async (e: any) => {
        const child = client.connection?.()?.session(e.sessionId);
        if (!child) return;
        try {
          await child.send('Network.enable');
          this.liveSessions.add(e.sessionId);
          this.bindSocketEvents(child, String(e.targetInfo?.type || 'worker'), e.sessionId);
        } catch {
          // Target went away mid-attach; nothing to unwind.
        } finally {
          if (e.waitingForDebugger) {
            await child.send('Runtime.runIfWaitingForDebugger').catch(() => {});
          }
        }
      });

      // A target that goes away takes its sockets with it and delivers no
      // webSocketClosed for them - a navigation replaces the worker, and its
      // socket would otherwise read as open forever.
      client.on('Target.detachedFromTarget', (e: any) => {
        this.liveSessions.delete(e.sessionId);
        for (const sock of this.sockets.values()) {
          if (sock.sessionId === e.sessionId && !sock.closedAt) {
            sock.closedAt = Date.now();
          }
        }
      });
      await client.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      });
    } catch {
      // No CDP session: HTTP monitoring still works, sockets are simply unseen.
    }
  }

  /**
   * Funnel one session's WebSocket lifecycle into the shared store.
   *
   * CDP requestIds are unique per session, not globally, so the store is keyed
   * by session and id together - two targets can otherwise overwrite each
   * other's sockets.
   */
  private bindSocketEvents(client: any, target: string, sessionId: string): void {
    const key = (requestId: string) => `${sessionId}:${requestId}`;
    client.on('Network.webSocketCreated', (e: any) => {
      this.sockets.set(key(e.requestId), {
        id: e.requestId, url: e.url, openedAt: Date.now(), errors: [], target, sessionId,
      });
      this.lastActivityTime = Date.now();
    });
    client.on('Network.webSocketClosed', (e: any) => {
      const sock = this.sockets.get(key(e.requestId));
      if (sock) sock.closedAt = Date.now();
      this.lastActivityTime = Date.now();
    });
    client.on('Network.webSocketFrameError', (e: any) => {
      const sock = this.sockets.get(key(e.requestId));
      if (sock) sock.errors.push(String(e.errorMessage || 'frame error'));
    });
    // Opcode 8 is the close frame. Sent by the page means it chose to hang up.
    client.on('Network.webSocketFrameSent', (e: any) => {
      if (e?.response?.opcode !== 8) return;
      const sock = this.sockets.get(key(e.requestId));
      if (sock) sock.clientClosed = true;
    });
  }

  /** Every WebSocket seen, oldest first. */
  getSockets(): StoredWebSocket[] {
    return [...this.sockets.values()]
      .map(s => ({
        ...s,
        // Answered now rather than at close time - see closedWithTarget. The
        // page session is never detached while monitoring runs, so a page
        // socket is only ever judged on its own close.
        closedWithTarget: !!s.closedAt && !this.liveSessions.has(s.sessionId),
      }))
      .sort((a, b) => a.openedAt - b.openedAt);
  }

  /** Open / closed / errored counts, for a health check. */
  getSocketHealth(): { total: number; open: number; closed: number; errored: number } {
    const all = this.getSockets();
    return {
      total: all.length,
      open: all.filter(s => !s.closedAt).length,
      closed: all.filter(s => s.closedAt).length,
      errored: all.filter(s => s.errors.length > 0).length,
    };
  }

  /**
   * Stop monitoring
   */
  stopMonitoring(page: Page): void {
    page.removeAllListeners('request');
    page.removeAllListeners('response');
    page.removeAllListeners('requestfailed');
    this.isMonitoring = false;
  }

  /**
   * Handle request start
   */
  private onRequest(request: HTTPRequest): void {
    const id = `network-${this.requestIdCounter++}`;
    this.lastActivityTime = Date.now();

    const storedRequest: StoredNetworkRequest = {
      id,
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      requestHeaders: request.headers(),
      postData: request.postData(),
      timing: {
        startTime: Date.now(),
      },
      failed: false,
    };

    this.requests.set(id, storedRequest);

    // Keep only last N requests
    if (this.requests.size > this.maxRequests) {
      const firstKey = this.requests.keys().next().value;
      if (firstKey) {
        this.requests.delete(firstKey);
      }
    }
  }

  /**
   * Handle response
   */
  private async onResponse(response: HTTPResponse): Promise<void> {
    const request = response.request();
    const url = request.url();

    // Find the stored request
    const storedRequest = Array.from(this.requests.values()).find(
      r => r.url === url && !r.response
    );

    if (storedRequest && storedRequest.timing) {
      storedRequest.timing.endTime = Date.now();
      storedRequest.timing.duration = storedRequest.timing.endTime - storedRequest.timing.startTime;

      try {
        // Get response body (only for certain content types to avoid binary data issues)
        let body: string | undefined;
        let bodySize: number | undefined;
        let bodyTokens: number | undefined;

        const contentType = response.headers()['content-type'] || '';
        const isText = contentType.includes('text') ||
                      contentType.includes('json') ||
                      contentType.includes('javascript');

        if (isText) {
          try {
            body = await response.text();
            // Track body size and estimate token count
            if (body) {
              bodySize = body.length;
              // Rough estimation: 1 token ≈ 4 characters
              bodyTokens = Math.ceil(bodySize / 4);
            }
          } catch {
            // Ignore errors when reading body
          }
        }

        storedRequest.response = {
          status: response.status(),
          statusText: response.statusText(),
          headers: response.headers(),
          body,
          bodySize,
          bodyTokens,
        };
      } catch (error) {
        // Response might not be available
      }
    }
  }

  /**
   * Handle request failure
   */
  private onRequestFailed(request: HTTPRequest): void {
    const url = request.url();

    // Find the stored request
    const storedRequest = Array.from(this.requests.values()).find(
      r => r.url === url && !r.failed
    );

    if (storedRequest) {
      storedRequest.failed = true;
      storedRequest.errorText = request.failure()?.errorText;
      if (storedRequest.timing) {
        storedRequest.timing.endTime = Date.now();
        storedRequest.timing.duration = storedRequest.timing.endTime - storedRequest.timing.startTime;
      }
    }
  }

  /**
   * Get all requests
   */
  getRequests(filter?: { resourceType?: string; limit?: number; offset?: number }): StoredNetworkRequest[] {
    let filtered = Array.from(this.requests.values());

    // Filter by resource type
    if (filter?.resourceType) {
      filtered = filtered.filter(req => req.resourceType === filter.resourceType);
    }

    // Apply offset and limit
    const offset = filter?.offset || 0;
    const limit = filter?.limit || filtered.length;

    return filtered.slice(offset, offset + limit);
  }

  /**
   * Get a request by ID
   */
  getRequest(id: string): StoredNetworkRequest | undefined {
    return this.requests.get(id);
  }

  /**
   * Clear all requests
   */
  clearSockets(): void {
    this.sockets.clear();
  }

  clear(): void {
    this.requests.clear();
    this.requestIdCounter = 0;
  }

  /**
   * Get request count
   */
  getCount(resourceType?: string): number {
    if (resourceType) {
      return Array.from(this.requests.values()).filter(
        req => req.resourceType === resourceType
      ).length;
    }
    return this.requests.size;
  }

  /**
   * Check if monitoring
   */
  isActive(): boolean {
    return this.isMonitoring;
  }

  /**
   * Get the timestamp of the last network activity
   */
  getLastActivityTime(): number {
    return this.lastActivityTime;
  }

  /**
   * Check if there has been network activity within the specified duration
   * @param withinMs - Duration in milliseconds to check for activity
   */
  hasRecentActivity(withinMs: number): boolean {
    return Date.now() - this.lastActivityTime < withinMs;
  }
}
