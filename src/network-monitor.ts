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

export class NetworkMonitor {
  private requests: Map<string, StoredNetworkRequest> = new Map();
  private requestIdCounter = 0;
  private maxRequests = 1000;
  private isMonitoring = false;

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

    this.isMonitoring = true;
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
}
