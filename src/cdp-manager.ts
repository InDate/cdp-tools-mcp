/**
 * CDP Connection Manager
 * Handles connection to Chrome DevTools Protocol (Chrome or Node.js)
 */

import CDP from 'chrome-remote-interface';
import type { BreakpointInfo, CallFrame, DebuggerState, RuntimeType, CDPConsoleMessage, ConsoleMessageCallback } from './types.js';
import type { SourceMapHandler } from './sourcemap-handler.js';

export class CDPManager {
  private client: any = null;
  private state: DebuggerState = {
    connected: false,
    paused: false,
    breakpoints: new Map(),
  };
  private scriptIdToUrl: Map<string, string> = new Map();
  private urlToScriptId: Map<string, string[]> = new Map(); // Support multiple scripts per URL (inline HTML scripts)
  private pauseResolvers: Array<() => void> = [];
  private scriptWaitResolvers: Array<{ pattern: string | RegExp; resolve: (url: string) => void }> = [];
  private sourceMapHandler: SourceMapHandler | null = null;
  private logpointLimitExceeded: {
    breakpointId: string;
    url: string;
    lineNumber: number;
    logMessage: string;
    executionCount: number;
    maxExecutions: number;
    logs: any[];
  } | null = null;
  private consoleMessageCallback: ConsoleMessageCallback | null = null;

  constructor(sourceMapHandler?: SourceMapHandler) {
    this.sourceMapHandler = sourceMapHandler || null;
  }

  /**
   * Set a callback to receive console messages from Runtime.consoleAPICalled
   * This is used for Node.js debugging where Puppeteer's page.on('console') isn't available
   */
  setConsoleMessageCallback(callback: ConsoleMessageCallback | null): void {
    this.consoleMessageCallback = callback;
  }

  /**
   * Find script IDs by URL, with fallback to base URL matching (strips query params)
   * This allows breakpoints to work across page reloads when cache-busting params change
   * Returns the most recently loaded script (highest scriptId) when multiple matches exist
   */
  private findScriptIds(url: string): { scriptIds: string[]; matchedUrl: string } | null {
    // First, try exact match
    const exactMatch = this.urlToScriptId.get(url);
    if (exactMatch && exactMatch.length > 0) {
      return { scriptIds: exactMatch, matchedUrl: url };
    }

    // Second, try matching by base URL (strip query params)
    // If multiple matches, prefer the one with the highest scriptId (most recent)
    const baseUrl = url.split('?')[0];
    let bestMatch: { scriptIds: string[]; matchedUrl: string } | null = null;
    let highestScriptId = -1;

    for (const [loadedUrl, scriptIds] of this.urlToScriptId.entries()) {
      const loadedBaseUrl = loadedUrl.split('?')[0];
      if (loadedBaseUrl === baseUrl && scriptIds.length > 0) {
        // Get the highest numeric scriptId from this entry
        const maxId = Math.max(...scriptIds.map(id => parseInt(id, 10) || 0));
        if (maxId > highestScriptId) {
          highestScriptId = maxId;
          bestMatch = { scriptIds, matchedUrl: loadedUrl };
        }
      }
    }

    return bestMatch;
  }

  /**
   * Connect to a Chrome or Node.js debugger instance
   * @param host - The debugger host (default: localhost)
   * @param port - The debugger port (default: 9222)
   * @param targetId - Optional target ID to connect to a specific page/tab
   */
  async connect(host: string = 'localhost', port: number = 9222, targetId?: string): Promise<void> {
    try {
      // If targetId is provided, connect to that specific target
      // Otherwise, connect to the default target
      const cdpOptions: any = { host, port };
      if (targetId) {
        cdpOptions.target = targetId;
      }
      this.client = await CDP(cdpOptions);

      const { Debugger, Runtime } = this.client;

      // Enable the Debugger domain
      await Debugger.enable();
      await Runtime.enable();

      // Detect runtime type
      this.state.runtimeType = await this.detectRuntimeType();

      // Set up event listeners
      Debugger.scriptParsed((params: any) => {
        this.scriptIdToUrl.set(params.scriptId, params.url);

        // Support multiple scripts per URL (inline HTML script blocks)
        const existingScripts = this.urlToScriptId.get(params.url) || [];
        this.urlToScriptId.set(params.url, [...existingScripts, params.scriptId]);

        // Register source map for lazy loading (loaded on-demand when needed)
        if (params.sourceMapURL && this.sourceMapHandler) {
          this.sourceMapHandler.registerSourceMap(params.url, params.sourceMapURL);
        }

        // Check if any waitForScript calls are waiting for this script
        const matchingResolvers: number[] = [];
        this.scriptWaitResolvers.forEach((waiter, index) => {
          const matches = typeof waiter.pattern === 'string'
            ? params.url.includes(waiter.pattern)
            : waiter.pattern.test(params.url);
          if (matches) {
            waiter.resolve(params.url);
            matchingResolvers.push(index);
          }
        });
        // Remove matched resolvers (in reverse order to maintain indices)
        matchingResolvers.reverse().forEach(index => {
          this.scriptWaitResolvers.splice(index, 1);
        });
      });

      Debugger.paused((params: any) => {
        this.state.paused = true;
        this.state.currentCallFrames = params.callFrames;

        // Resolve all pending pause promises
        const resolvers = this.pauseResolvers.splice(0);
        resolvers.forEach(resolve => resolve());

        // Inject clickable console link when paused at breakpoint
        if (params.callFrames && params.callFrames.length > 0) {
          const location = params.callFrames[0].location;
          const url = this.scriptIdToUrl.get(location.scriptId) || 'unknown';
          this.injectConsoleLink(url, location.lineNumber, '⏸️ Paused at');
        }
      });

      Debugger.resumed(() => {
        this.state.paused = false;
        this.state.currentCallFrames = undefined;
      });

      // Listen for breakpoint resolution - updates pending breakpoints when script loads
      Debugger.breakpointResolved((params: any) => {
        const { breakpointId, location } = params;
        const existingBp = this.state.breakpoints.get(breakpointId);
        if (existingBp && existingBp.status === 'pending') {
          // Update the breakpoint from pending to resolved
          existingBp.status = 'resolved';
          existingBp.location = location;
          this.state.breakpoints.set(breakpointId, existingBp);
        }
      });

      // Listen for console messages via CDP (works for both Chrome and Node.js)
      // This enables console capture for Node.js where Puppeteer isn't available
      Runtime.consoleAPICalled((params: CDPConsoleMessage) => {
        if (this.consoleMessageCallback) {
          this.consoleMessageCallback(params);
        }
      });

      this.state.connected = true;
    } catch (error) {
      throw new Error(`Failed to connect to debugger: ${error}`);
    }
  }

  /**
   * Disconnect from the debugger
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.state.connected = false;
      this.state.paused = false;
      this.state.currentCallFrames = undefined;
      this.state.runtimeType = undefined;
      this.state.breakpoints.clear();
      this.scriptIdToUrl.clear();
      this.urlToScriptId.clear();
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.state.connected;
  }

  /**
   * Check if currently paused at a breakpoint
   */
  isPaused(): boolean {
    return this.state.paused;
  }

  /**
   * Get the runtime type (chrome, node, or unknown)
   */
  getRuntimeType(): RuntimeType {
    return this.state.runtimeType || 'unknown';
  }

  /**
   * Detect whether we're connected to Chrome/browser or Node.js
   * This detection happens by checking for browser-specific global objects
   */
  private async detectRuntimeType(): Promise<RuntimeType> {
    if (!this.client) {
      return 'unknown';
    }

    try {
      const { Runtime } = this.client;

      // Try to evaluate 'typeof window' - exists in browsers, not in Node.js
      const windowCheck = await Runtime.evaluate({
        expression: 'typeof window',
        silent: true,
      });

      // If 'window' is defined, we're in a browser (Chrome)
      if (windowCheck.result.type === 'object' ||
          windowCheck.result.value === 'object') {
        return 'chrome';
      }

      // Try to evaluate 'typeof process' - exists in Node.js, not in browsers
      const processCheck = await Runtime.evaluate({
        expression: 'typeof process',
        silent: true,
      });

      // If 'process' is an object, we're in Node.js
      if (processCheck.result.type === 'object' ||
          processCheck.result.value === 'object') {
        return 'node';
      }

      return 'unknown';
    } catch (error) {
      console.error('Failed to detect runtime type:', error);
      return 'unknown';
    }
  }

  /**
   * Set a breakpoint at a specific file and line
   */
  async setBreakpoint(url: string, lineNumber: number, columnNumber?: number, condition?: string): Promise<BreakpointInfo> {
    if (!this.state.connected) {
      throw new Error('Not connected to debugger');
    }

    const { Debugger } = this.client;

    // IMPORTANT: CDP uses 0-based line and column numbers internally
    // User provides 1-based numbers (line 1 = first line, column 1 = first column)
    // We must convert before calling CDP API
    const cdpLineNumber = lineNumber - 1;  // Convert 1-based → 0-based
    const cdpColumnNumber = columnNumber !== undefined ? columnNumber - 1 : undefined;  // Convert 1-based → 0-based

    // Try to find actual URL if the provided one has query params that may differ
    // This handles cache-busting params like ?v=123 that change on rebuild
    let actualUrl = url;
    const match = this.findScriptIds(url);
    if (match && match.matchedUrl !== url) {
      actualUrl = match.matchedUrl;
    }

    // Set breakpoint using 0-based CDP numbers
    const result = await Debugger.setBreakpointByUrl({
      url: actualUrl,
      lineNumber: cdpLineNumber,
      columnNumber: cdpColumnNumber,
      condition,
    });

    // Check if breakpoint was resolved to any location
    // Per CDP spec, setBreakpointByUrl can return empty locations if script isn't loaded yet
    // The breakpoint is still valid and will activate when the script loads
    if (!result.locations || result.locations.length === 0) {
      // Breakpoint is pending - script not loaded yet but breakpoint is queued
      const breakpointInfo: BreakpointInfo = {
        breakpointId: result.breakpointId,
        // For pending breakpoints, we don't have a resolved location yet
        // Use a placeholder that indicates pending state
        location: {
          scriptId: '',
          lineNumber: cdpLineNumber,  // Store the requested 0-based line
          columnNumber: cdpColumnNumber,
        },
        originalLocation: { url, lineNumber, columnNumber },
        status: 'pending',
      };

      this.state.breakpoints.set(result.breakpointId, breakpointInfo);
      return breakpointInfo;
    }

    // Warn if multiple locations (rare but possible)
    if (result.locations.length > 1) {
      console.error(`[cdp-tools] Warning: Breakpoint matched ${result.locations.length} locations. Using first match.`);
    }

    // Store breakpoint info
    // - location: Actual location from CDP (0-based)
    // - originalLocation: User-requested location (1-based, what user asked for)
    const breakpointInfo: BreakpointInfo = {
      breakpointId: result.breakpointId,
      location: result.locations[0],
      originalLocation: { url, lineNumber, columnNumber },
      status: 'resolved',
    };

    this.state.breakpoints.set(result.breakpointId, breakpointInfo);
    return breakpointInfo;
  }

  /**
   * Remove a breakpoint
   */
  async removeBreakpoint(breakpointId: string): Promise<void> {
    if (!this.state.connected) {
      throw new Error('Not connected to debugger');
    }

    const { Debugger } = this.client;
    await Debugger.removeBreakpoint({ breakpointId });
    this.state.breakpoints.delete(breakpointId);
  }

  /**
   * Get all active breakpoints
   */
  getBreakpoints(): BreakpointInfo[] {
    return Array.from(this.state.breakpoints.values());
  }

  /**
   * Get breakpoint counts (total, regular, logpoints)
   */
  getBreakpointCounts(): { total: number; breakpoints: number; logpoints: number } {
    const all = this.getBreakpoints();
    const logpoints = all.filter(bp => bp.isLogpoint).length;
    const regularBreakpoints = all.length - logpoints;

    return {
      total: all.length,
      breakpoints: regularBreakpoints,
      logpoints,
    };
  }

  /**
   * Wait for a script matching the given URL pattern to load
   * @param urlPattern - String (substring match) or RegExp to match against script URLs
   * @param timeout - Maximum time to wait in milliseconds (default: 10000)
   * @returns The URL of the matched script
   * @throws Error if timeout expires before script loads
   */
  async waitForScript(urlPattern: string | RegExp, timeout: number = 10000): Promise<string> {
    if (!this.state.connected) {
      throw new Error('Not connected to debugger');
    }

    // First, check if script is already loaded
    for (const url of this.urlToScriptId.keys()) {
      const matches = typeof urlPattern === 'string'
        ? url.includes(urlPattern)
        : urlPattern.test(url);
      if (matches) {
        return url;  // Script already loaded
      }
    }

    // Script not loaded yet, wait for it
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        // Remove this waiter from the list
        const index = this.scriptWaitResolvers.findIndex(w => w.resolve === resolveWrapper);
        if (index >= 0) {
          this.scriptWaitResolvers.splice(index, 1);
        }
        reject(new Error(`Timeout: Script matching "${urlPattern}" did not load within ${timeout}ms`));
      }, timeout);

      const resolveWrapper = (url: string) => {
        clearTimeout(timeoutId);
        resolve(url);
      };

      this.scriptWaitResolvers.push({
        pattern: urlPattern,
        resolve: resolveWrapper,
      });
    });
  }

  /**
   * Get list of all loaded scripts
   * @returns Array of script URLs
   */
  getLoadedScripts(): string[] {
    return Array.from(this.urlToScriptId.keys());
  }

  /**
   * Check if a script matching the pattern is loaded
   * @param urlPattern - String (substring match) or RegExp
   * @returns The matched URL or null
   */
  findLoadedScript(urlPattern: string | RegExp): string | null {
    for (const url of this.urlToScriptId.keys()) {
      const matches = typeof urlPattern === 'string'
        ? url.includes(urlPattern)
        : urlPattern.test(url);
      if (matches) {
        return url;
      }
    }
    return null;
  }

  /**
   * Synchronize breakpoint state with CDP's actual breakpoints
   * Use this to recover from state desynchronization
   */
  async syncBreakpoints(): Promise<{ synced: number; removed: number }> {
    if (!this.state.connected) {
      throw new Error('Not connected to debugger');
    }

    // This is a future enhancement - for now, just return current counts
    // Full implementation would query CDP for all active breakpoints
    // and reconcile with state.breakpoints Map
    return {
      synced: this.state.breakpoints.size,
      removed: 0,
    };
  }

  /**
   * Diagnose why a breakpoint failed to set (empty locations array)
   * Performs lazy validation to determine exact cause
   */
  async diagnoseBreakpointFailure(url: string, lineNumber: number): Promise<{
    cause: 'script_not_found' | 'line_out_of_bounds' | 'line_not_executable';
    message: string;
    scriptUrl: string;
    requestedLine: number;
    totalLines?: number;
    suggestion: string;
  }> {
    // Check if we have this script loaded (with fallback to base URL matching)
    const match = this.findScriptIds(url);

    if (!match) {
      return {
        cause: 'script_not_found',
        message: `Script not loaded: ${url}`,
        scriptUrl: url,
        requestedLine: lineNumber,
        suggestion: 'The script has not been loaded by Chrome yet. Use reloadPage() or navigateTo() to ensure the script loads.'
      };
    }

    const { scriptIds } = match;

    // Script exists - check each scriptId to find which contains the requested line
    try {
      const { Debugger } = this.client;

      // Try each script to find one that contains the requested line
      for (const scriptId of scriptIds) {
        const source = await Debugger.getScriptSource({ scriptId });
        const totalLines = source.scriptSource.split('\n').length;

        // Check if this script contains the requested line
        if (lineNumber <= totalLines) {
          // This script contains the line - check if it's executable
          return {
            cause: 'line_not_executable',
            message: `Line ${lineNumber} is not executable code`,
            scriptUrl: url,
            requestedLine: lineNumber,
            totalLines: totalLines,
            suggestion: 'This line may be a comment, blank line, or non-executable declaration. Try setting the breakpoint on a nearby line with executable code (function call, assignment, etc.).'
          };
        }
      }

      // Line number exceeds all scripts - get the maximum lines from all scripts
      let maxLines = 0;
      for (const scriptId of scriptIds) {
        const source = await Debugger.getScriptSource({ scriptId });
        const lineCount = source.scriptSource.split('\n').length;
        maxLines = Math.max(maxLines, lineCount);
      }

      return {
        cause: 'line_out_of_bounds',
        message: `Line ${lineNumber} is out of bounds`,
        scriptUrl: url,
        requestedLine: lineNumber,
        totalLines: maxLines,
        suggestion: scriptIds.length > 1
          ? `This URL has ${scriptIds.length} inline scripts. The largest has ${maxLines} lines. Use searchCode() to find the correct script and line.`
          : `The script only has ${maxLines} lines. Use getSourceCode() to view the file and find valid line numbers.`
      };
    } catch (error) {
      // Fallback if we can't get script source
      return {
        cause: 'script_not_found',
        message: `Unable to access script: ${url}`,
        scriptUrl: url,
        requestedLine: lineNumber,
        suggestion: 'The script may have been unloaded. Try reloadPage().'
      };
    }
  }

  /**
   * Resume execution
   */
  async resume(): Promise<void> {
    if (!this.state.connected) {
      throw new Error('Not connected to debugger');
    }

    const { Debugger } = this.client;
    await Debugger.resume();
  }

  /**
   * Pause execution
   */
  async pause(): Promise<void> {
    if (!this.state.connected) {
      throw new Error('Not connected to debugger');
    }

    const { Debugger } = this.client;
    await Debugger.pause();
  }

  /**
   * Handle logpoint execution limit exceeded
   * This should be called by the LogpointExecutionTracker when a logpoint hits its limit
   */
  async handleLogpointLimitExceeded(metadata: {
    breakpointId: string;
    url: string;
    lineNumber: number;
    logMessage: string;
    executionCount: number;
    maxExecutions: number;
    logs: any[];
  }): Promise<void> {
    // Store the metadata
    this.logpointLimitExceeded = metadata;

    // Pause execution
    await this.pause();
  }

  /**
   * Get information about the logpoint that exceeded its limit (if any)
   */
  getLogpointLimitExceeded(): typeof this.logpointLimitExceeded {
    return this.logpointLimitExceeded;
  }

  /**
   * Clear the logpoint limit exceeded state
   */
  clearLogpointLimitExceeded(): void {
    this.logpointLimitExceeded = null;
  }

  /**
   * Step over (next line)
   */
  async stepOver(): Promise<void> {
    if (!this.state.connected) {
      throw new Error('Not connected to debugger');
    }

    const { Debugger } = this.client;
    await Debugger.stepOver();
  }

  /**
   * Step into function
   */
  async stepInto(): Promise<void> {
    if (!this.state.connected) {
      throw new Error('Not connected to debugger');
    }

    const { Debugger } = this.client;
    await Debugger.stepInto();
  }

  /**
   * Step out of function
   */
  async stepOut(): Promise<void> {
    if (!this.state.connected) {
      throw new Error('Not connected to debugger');
    }

    const { Debugger } = this.client;
    await Debugger.stepOut();
  }

  /**
   * Get current call stack
   */
  getCallStack(): CallFrame[] | undefined {
    if (!this.state.paused || !this.state.currentCallFrames) {
      return undefined;
    }

    return this.state.currentCallFrames.map((frame: any) => ({
      callFrameId: frame.callFrameId,
      functionName: frame.functionName || '(anonymous)',
      location: frame.location,
      url: this.scriptIdToUrl.get(frame.location.scriptId) || 'unknown',
      scopeChain: frame.scopeChain,
    }));
  }

  /**
   * Get variables for a specific call frame
   */
  /**
   * Estimate token count for a value (rough approximation: ~4 chars per token)
   */
  private estimateTokens(value: any): number {
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    return Math.ceil(str.length / 4);
  }

  async getVariables(
    callFrameId: string,
    includeGlobal: boolean = false,
    filter?: string,
    expandObjects: boolean = true,
    maxDepth: number = 2,
    maxTokens: number = 1000
  ): Promise<{ variables: any[]; totalCount: number; usedDepth: number; requestedDepth: number; tokenEstimate: number; requiresFilter: boolean }> {
    if (!this.state.connected) {
      throw new Error('Not connected to debugger');
    }

    const { Runtime } = this.client;
    const callFrame = this.state.currentCallFrames?.find(
      (frame: any) => frame.callFrameId === callFrameId
    );

    if (!callFrame) {
      throw new Error(`Call frame ${callFrameId} not found`);
    }

    const filterRegex = filter ? new RegExp(filter, 'i') : null;
    const requestedDepth = maxDepth;

    // Collect property metadata first (without expanding)
    const propertyMeta: Array<{ prop: any; scopeType: string }> = [];

    for (const scope of callFrame.scopeChain) {
      if (scope.type === 'global' && !includeGlobal) {
        continue;
      }

      const properties = await Runtime.getProperties({
        objectId: scope.object.objectId,
        ownProperties: true,
      });

      for (const prop of properties.result) {
        if (!prop.value) continue;
        if (filterRegex && !filterRegex.test(prop.name)) continue;
        propertyMeta.push({ prop, scopeType: scope.type });
      }
    }

    const totalCount = propertyMeta.length;

    // Try progressively lower depths until under token limit
    for (let currentDepth = maxDepth; currentDepth >= 0; currentDepth--) {
      const variables: any[] = [];
      const shouldExpand = expandObjects && currentDepth > 0;

      for (const { prop, scopeType } of propertyMeta) {
        variables.push({
          name: prop.name,
          value: await this.formatValue(prop.value, shouldExpand, currentDepth),
          type: prop.value.type,
          scopeType,
        });
      }

      const tokenEstimate = this.estimateTokens(variables);

      if (tokenEstimate <= maxTokens) {
        return {
          variables,
          totalCount,
          usedDepth: currentDepth,
          requestedDepth,
          tokenEstimate,
          requiresFilter: false
        };
      }
    }

    // Even at depth 0, still over limit - require filter
    const variables: any[] = [];
    for (const { prop, scopeType } of propertyMeta) {
      variables.push({
        name: prop.name,
        value: await this.formatValue(prop.value, false, 0),
        type: prop.value.type,
        scopeType,
      });
    }

    return {
      variables: [], // Return empty - require filter
      totalCount,
      usedDepth: 0,
      requestedDepth,
      tokenEstimate: this.estimateTokens(variables),
      requiresFilter: true
    };
  }

  /**
   * Evaluate an expression in the current context
   */
  async evaluateExpression(
    expression: string,
    callFrameId?: string,
    expandObjects: boolean = true,
    maxDepth: number = 2
  ): Promise<any> {
    if (!this.state.connected) {
      throw new Error('Not connected to debugger');
    }

    const { Debugger } = this.client;

    if (callFrameId) {
      const result = await Debugger.evaluateOnCallFrame({
        callFrameId,
        expression,
      });
      return await this.formatValue(result.result, expandObjects, maxDepth);
    } else {
      const { Runtime } = this.client;
      const result = await Runtime.evaluate({ expression });
      return await this.formatValue(result.result, expandObjects, maxDepth);
    }
  }

  /**
   * Get available variables at a specific source location
   * Useful for validating logpoint expressions
   */
  async getScopeVariablesAtLocation(
    url: string,
    lineNumber: number
  ): Promise<{ variables: string[]; scopes: Array<{ type: string; variables: string[] }> } | null> {
    if (!this.state.connected) {
      throw new Error('Not connected to debugger');
    }

    // Temporarily set a breakpoint to inspect scope
    const tempBreakpoint = await this.setBreakpoint(url, lineNumber);

    try {
      // Wait for the breakpoint to be hit (with timeout)
      // Note: This requires the code to actually execute
      // For static analysis, we'd need a different approach

      // For now, return null to indicate we can't determine scope without execution
      // This would require the debugger to be paused at that location
      if (!this.state.paused || !this.state.currentCallFrames) {
        // Remove the temporary breakpoint
        await this.removeBreakpoint(tempBreakpoint.breakpointId);
        return null;
      }

      // Get the call frame
      const callFrame = this.state.currentCallFrames[0];

      // Extract variable names from all scopes
      const { Runtime } = this.client;
      const scopes: Array<{ type: string; variables: string[] }> = [];
      const allVariables: string[] = [];

      for (const scope of callFrame.scopeChain) {
        if (scope.type === 'global') continue; // Skip global scope

        const properties = await Runtime.getProperties({
          objectId: scope.object.objectId,
          ownProperties: true,
        });

        const variableNames = properties.result
          .filter((prop: any) => prop.value && !prop.name.startsWith('[['))
          .map((prop: any) => prop.name);

        scopes.push({
          type: scope.type,
          variables: variableNames,
        });

        allVariables.push(...variableNames);
      }

      // Remove the temporary breakpoint
      await this.removeBreakpoint(tempBreakpoint.breakpointId);

      return {
        variables: [...new Set(allVariables)], // Deduplicate
        scopes,
      };
    } catch (error) {
      // Clean up the breakpoint if something goes wrong
      try {
        await this.removeBreakpoint(tempBreakpoint.breakpointId);
      } catch (e) {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  /**
   * Validate logpoint expressions at a specific location
   * Sets temp breakpoint, waits for execution, tests expressions
   *
   * @param url File URL (e.g., http://localhost:3000/app.js)
   * @param lineNumber Line number (1-based, will be converted to 0-based for CDP)
   * @param columnNumber Optional column number (1-based, will be converted to 0-based for CDP)
   * @param expressions Array of expressions to validate (e.g., ["user.name", "user.id"])
   * @param timeout Max wait time for execution in milliseconds
   * @returns Validation results with pass/fail for each expression, plus available variables
   */
  async validateLogpointAtActualLocation(
    url: string,
    lineNumber: number,
    columnNumber: number | undefined,
    expressions: string[],
    timeout: number = 2000
  ): Promise<{
    executed: boolean;
    allValid: boolean;
    results: Array<{ expression: string; valid: boolean; value?: any; error?: string }>;
    availableVariables?: string[];
    actualLocation?: { line: number; column: number };  // 1-based for user display
  }> {
    if (!this.state.connected) {
      throw new Error('Not connected to debugger');
    }

    // Note: lineNumber and columnNumber are 1-based (user input)
    // setBreakpoint will convert them to 0-based for CDP
    const tempBreakpoint = await this.setBreakpoint(url, lineNumber, columnNumber);

    try {
      // Wait for execution with timeout
      await new Promise(resolve => setTimeout(resolve, timeout));

      // Check if we paused at the breakpoint
      if (!this.state.paused || !this.state.currentCallFrames) {
        // Code didn't execute - remove breakpoint and return
        await this.removeBreakpoint(tempBreakpoint.breakpointId);
        return {
          executed: false,
          allValid: false,
          results: expressions.map(expr => ({
            expression: expr,
            valid: false,
            error: 'Code has not executed yet - cannot validate without execution'
          })),
        };
      }

      // Get actual location from CDP (0-based)
      const actualLocation = tempBreakpoint.location;
      const actualLineUser = actualLocation.lineNumber + 1;  // Convert 0-based → 1-based
      const actualColumnUser = actualLocation.columnNumber !== undefined
        ? actualLocation.columnNumber + 1  // Convert 0-based → 1-based
        : undefined;

      // Get call frame for evaluation
      const callFrame = this.state.currentCallFrames[0];

      // Collect all available variables
      const { Runtime } = this.client;
      const availableVariables: string[] = [];

      for (const scope of callFrame.scopeChain) {
        if (scope.type === 'global') continue;  // Skip global

        const properties = await Runtime.getProperties({
          objectId: scope.object.objectId,
          ownProperties: true,
        });

        properties.result
          .filter((prop: any) => prop.value && !prop.name.startsWith('[['))
          .forEach((prop: any) => availableVariables.push(prop.name));
      }

      // Evaluate each expression
      const results: Array<{ expression: string; valid: boolean; value?: any; error?: string }> = [];

      for (const expr of expressions) {
        try {
          const value = await this.evaluateExpression(expr, callFrame.callFrameId);
          results.push({
            expression: expr,
            valid: true,
            value,
          });
        } catch (error) {
          results.push({
            expression: expr,
            valid: false,
            error: String(error),
          });
        }
      }

      // Resume execution
      await this.resume();

      // Remove temp breakpoint
      await this.removeBreakpoint(tempBreakpoint.breakpointId);

      const allValid = results.every(r => r.valid);

      return {
        executed: true,
        allValid,
        results,
        availableVariables: [...new Set(availableVariables)],  // Deduplicate
        actualLocation: {
          line: actualLineUser,
          column: actualColumnUser!,
        },
      };
    } catch (error) {
      // Clean up on error
      try {
        if (this.state.paused) {
          await this.resume();
        }
        await this.removeBreakpoint(tempBreakpoint.breakpointId);
      } catch (e) {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  /**
   * Search for the best location to set a logpoint by trying nearby lines/columns
   * Returns suggestions ranked by how many expressions are valid
   *
   * @param url File URL
   * @param lineNumber Desired line number (1-based)
   * @param columnNumber Desired column number (1-based, optional)
   * @param expressions Array of expressions to validate
   * @param searchRadius Number of lines to search in each direction (default: 2)
   * @param timeout Timeout per location test in milliseconds (default: 1000ms)
   * @returns Array of suggestions sorted by score (best first), max 3 results
   */
  async findBestLogpointLocation(
    url: string,
    lineNumber: number,
    columnNumber: number | undefined,
    expressions: string[],
    searchRadius: number = 2,
    timeout: number = 1000
  ): Promise<Array<{
    line: number;
    column: number | undefined;
    score: number;
    validExpressions: string[];
    invalidExpressions: string[];
    availableVariables: string[];
    reason: string;
  }>> {
    const candidates: Array<{
      line: number;
      column: number | undefined;
      score: number;
      validExpressions: string[];
      invalidExpressions: string[];
      availableVariables: string[];
      reason: string;
    }> = [];

    // Try requested line first, then ±1, ±2, etc.
    for (let offset = 0; offset <= searchRadius; offset++) {
      const lines = offset === 0 ? [lineNumber] : [lineNumber - offset, lineNumber + offset];

      for (const line of lines) {
        if (line < 1) continue;  // Skip negative lines

        try {
          const validation = await this.validateLogpointAtActualLocation(
            url,
            line,
            columnNumber,
            expressions,
            timeout
          );

          if (validation.executed) {
            const validCount = validation.results.filter(r => r.valid).length;
            const score = Math.round((validCount / expressions.length) * 100);

            candidates.push({
              line: validation.actualLocation?.line || line,
              column: validation.actualLocation?.column,
              score,
              validExpressions: validation.results.filter(r => r.valid).map(r => r.expression),
              invalidExpressions: validation.results.filter(r => !r.valid).map(r => r.expression),
              availableVariables: validation.availableVariables || [],
              reason: score === 100 ? 'All expressions available in scope' :
                      score > 0 ? `${validCount}/${expressions.length} expressions available` :
                      'No expressions available'
            });
          }
        } catch (e) {
          // Skip locations that error
          continue;
        }
      }
    }

    // Sort by score (highest first), then by proximity to original line
    candidates.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;  // Higher score first
      }
      // If scores equal, prefer closer to original line
      return Math.abs(a.line - lineNumber) - Math.abs(b.line - lineNumber);
    });

    // Return top 3
    return candidates.slice(0, 3);
  }

  /**
   * Get source code from a file at a specific line range
   */
  async getSourceCode(
    url: string,
    startLine?: number,
    endLine?: number
  ): Promise<{ code: string; totalLines: number; hasSourceMap: boolean }> {
    if (!this.state.connected) {
      throw new Error('Not connected to debugger');
    }

    const { Debugger } = this.client;

    // Find the script IDs for this URL (may be multiple for inline HTML)
    const scriptIds = this.urlToScriptId.get(url);
    if (!scriptIds || scriptIds.length === 0) {
      throw new Error(`Script not found for URL: ${url}. Make sure the script has been loaded/parsed.`);
    }

    // If multiple scripts, find the one containing the requested line range
    let scriptId: string;
    let fullSource: string;
    let totalLines: number;

    if (scriptIds.length === 1) {
      // Only one script - use it
      scriptId = scriptIds[0];
      const result = await Debugger.getScriptSource({ scriptId });
      fullSource = result.scriptSource;
      totalLines = fullSource.split('\n').length;
    } else {
      // Multiple scripts - find the one containing the requested line
      const targetLine = startLine || 1;
      let found = false;

      for (const sid of scriptIds) {
        const result = await Debugger.getScriptSource({ scriptId: sid });
        const source = result.scriptSource;
        const lineCount = source.split('\n').length;

        // Check if this script contains the requested line
        if (targetLine <= lineCount) {
          scriptId = sid;
          fullSource = source;
          totalLines = lineCount;
          found = true;
          break;
        }
      }

      if (!found) {
        throw new Error(`Line ${targetLine} not found in any script for URL: ${url}. This URL has ${scriptIds.length} inline scripts.`);
      }
    }

    // Split into lines
    const lines = fullSource!.split('\n');

    // Determine the range
    const start = startLine ? Math.max(1, startLine) : 1;
    const end = endLine ? Math.min(totalLines!, endLine) : (startLine ? Math.min(totalLines!, startLine + 9) : totalLines!);

    // Extract the requested lines (convert to 0-indexed)
    const extractedLines = lines.slice(start - 1, end);

    // Format with line numbers
    const formattedCode = extractedLines
      .map((line: string, index: number) => {
        const lineNum = start + index;
        return `${String(lineNum).padStart(4, ' ')} | ${line}`;
      })
      .join('\n');

    // Check if source map is available
    const hasSourceMap = this.sourceMapHandler?.hasSourceMap(url) || false;

    return {
      code: formattedCode,
      totalLines: totalLines!,
      hasSourceMap,
    };
  }

  /**
   * Inject a clickable console link in the browser
   */
  async injectConsoleLink(url: string, lineNumber: number, message: string): Promise<void> {
    if (!this.state.connected) {
      return;
    }

    const { Runtime } = this.client;

    const consoleExpression = `
      console.log(
        '${message} %c${url}:${lineNumber}%c',
        'color: #0066cc; text-decoration: underline; cursor: pointer; font-weight: bold',
      );
    `;

    try {
      await Runtime.evaluate({ expression: consoleExpression });
    } catch (error) {
      // Ignore errors if console injection fails
    }
  }

  /**
   * Get detailed information about current pause state
   */
  getPausedInfo(): { paused: boolean; location?: any; callStack?: CallFrame[] } {
    if (!this.state.paused) {
      return { paused: false };
    }

    const callStack = this.getCallStack();
    const location = callStack && callStack.length > 0 ? {
      url: callStack[0].url,
      lineNumber: callStack[0].location.lineNumber,
      columnNumber: callStack[0].location.columnNumber,
      functionName: callStack[0].functionName,
    } : undefined;

    return {
      paused: true,
      location,
      callStack,
    };
  }

  /**
   * Wait for debugger to pause (for race detection)
   * Returns a promise that resolves when debugger pauses, or rejects on timeout
   */
  waitForPause(timeoutMs: number = 30000): Promise<void> {
    if (this.state.paused) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        // Remove resolver from list
        const index = this.pauseResolvers.indexOf(resolve);
        if (index > -1) {
          this.pauseResolvers.splice(index, 1);
        }
        reject(new Error('Timeout waiting for pause'));
      }, timeoutMs);

      const wrappedResolve = () => {
        clearTimeout(timeout);
        resolve();
      };

      this.pauseResolvers.push(wrappedResolve);
    });
  }

  /**
   * Format a CDP RemoteObject value for display
   * @param value The CDP RemoteObject to format
   * @param expandObjects Whether to expand object/array contents (default: false for backward compatibility)
   * @param maxDepth Maximum depth for object expansion (default: 2)
   * @param currentDepth Current recursion depth (internal use)
   */
  private async formatValue(
    value: any,
    expandObjects: boolean = false,
    maxDepth: number = 2,
    currentDepth: number = 0
  ): Promise<any> {
    if (value.type === 'undefined') return 'undefined';
    if (value.type === 'string') return `"${value.value}"`;
    if (value.type === 'number' || value.type === 'boolean') return String(value.value);
    if (value.type === 'object') {
      if (value.subtype === 'null') return 'null';

      // Detect and handle DOM nodes specially (never expand)
      const className = value.className || '';
      if (className.startsWith('HTML') || className.includes('Element') || value.subtype === 'node') {
        return `[${className || 'DOMNode'}]`;
      }

      // If expansion is disabled or we've hit max depth, return description
      if (!expandObjects || currentDepth >= maxDepth) {
        if (value.subtype === 'array') return `Array(${value.description})`;
        return value.description || value.className || 'Object';
      }

      // Expand object/array contents with smart size limits
      if (value.objectId) {
        try {
          const { Runtime } = this.client;
          const properties = await Runtime.getProperties({
            objectId: value.objectId,
            ownProperties: true,
          });

          if (value.subtype === 'array') {
            // Smart array handling based on size
            const numericProps = properties.result.filter((p: any) => !isNaN(parseInt(p.name, 10)));
            const arrayLength = numericProps.length;

            // For large arrays, truncate to first 10 elements
            if (arrayLength > 20) {
              const arrayElements: any[] = [];
              let itemsShown = 0;
              for (const prop of numericProps.slice(0, 10)) {
                const index = parseInt(prop.name, 10);
                if (prop.value) {
                  arrayElements[index] = await this.formatValue(
                    prop.value,
                    expandObjects,
                    maxDepth,
                    currentDepth + 1
                  );
                  itemsShown++;
                }
              }
              // Add truncation indicator
              arrayElements.push(`... ${arrayLength - itemsShown} more items (use evaluateExpression to inspect)`);
              return arrayElements;
            }

            // Small arrays - show all elements
            const arrayElements: any[] = [];
            for (const prop of properties.result) {
              const index = parseInt(prop.name, 10);
              if (!isNaN(index) && prop.value) {
                arrayElements[index] = await this.formatValue(
                  prop.value,
                  expandObjects,
                  maxDepth,
                  currentDepth + 1
                );
              }
            }
            return arrayElements;
          } else {
            // Smart object handling based on property count
            const validProps = properties.result.filter((p: any) => p.value && !p.name.startsWith('[['));
            const propCount = validProps.length;

            // For very large objects, show summary with first few keys
            if (propCount > 50) {
              const firstKeys = validProps.slice(0, 5).map((p: any) => p.name);
              return `[Object with ${propCount} properties] {${firstKeys.join(', ')}, ...} - use evaluateExpression to inspect`;
            }

            // For moderately large objects (10-50 props), limit depth
            if (propCount > 10 && currentDepth > 0) {
              const firstKeys = validProps.slice(0, 10).map((p: any) => p.name);
              return `[Object with ${propCount} properties] {${firstKeys.join(', ')}${propCount > 10 ? ', ...' : ''}}`;
            }

            // Small objects - expand normally
            const objectProps: Record<string, any> = {};
            for (const prop of validProps) {
              objectProps[prop.name] = await this.formatValue(
                prop.value,
                expandObjects,
                maxDepth,
                currentDepth + 1
              );
            }
            return objectProps;
          }
        } catch (error) {
          // If expansion fails, fall back to description
          if (value.subtype === 'array') return `Array(${value.description})`;
          return value.description || value.className || 'Object';
        }
      }

      // No objectId, can't expand
      if (value.subtype === 'array') return `Array(${value.description})`;
      return value.description || value.className || 'Object';
    }
    if (value.type === 'function') {
      // Extract just the function name/signature, not the full source
      const desc = value.description || '';
      const match = desc.match(/^(function\s+\w+|async\s+function\s+\w+|\w+)\s*\(/);
      if (match) {
        return `[Function: ${match[1]}]`;
      }
      return '[Function]';
    }
    return String(value.value);
  }

  /**
   * Expand a CDP RemoteObject by its objectId
   * This is used to get full object details for console messages
   * @param objectId - The CDP object ID to expand
   * @param maxDepth - Maximum depth for nested object expansion (default: 2)
   */
  async expandObjectById(objectId: string, maxDepth: number = 2): Promise<any> {
    if (!this.state.connected || !this.client) {
      throw new Error('Not connected to debugger');
    }

    const { Runtime } = this.client;

    // Get the object properties
    const properties = await Runtime.getProperties({
      objectId,
      ownProperties: true,
    });

    // Build the expanded object
    const result: Record<string, any> = {};
    const validProps = properties.result.filter((p: any) => p.value && !p.name.startsWith('[['));

    for (const prop of validProps.slice(0, 20)) { // Limit to 20 properties for console output
      result[prop.name] = await this.formatValue(prop.value, true, maxDepth, 0);
    }

    if (validProps.length > 20) {
      result['...'] = `(${validProps.length - 20} more properties)`;
    }

    return result;
  }

  /**
   * Get all loaded scripts
   */
  getAllScripts(): Array<{ scriptId: string; url: string }> {
    return Array.from(this.scriptIdToUrl.entries()).map(([scriptId, url]) => ({
      scriptId,
      url,
    }));
  }

  /**
   * Search within a specific script using regex
   */
  async searchInScript(
    scriptId: string,
    pattern: string,
    caseSensitive: boolean = false,
    isRegex: boolean = true
  ): Promise<Array<{ lineNumber: number; lineContent: string }>> {
    if (!this.state.connected) {
      throw new Error('Not connected to debugger');
    }

    const { Debugger } = this.client;

    try {
      const result = await Debugger.searchInContent({
        scriptId,
        query: pattern,
        caseSensitive,
        isRegex,
      });

      return (result.result || []).map((match: any) => ({
        lineNumber: match.lineNumber,
        lineContent: match.lineContent,
      }));
    } catch (error) {
      // Script might not support search or other error
      return [];
    }
  }

  /**
   * Get a specific line from a script by scriptId and line number
   * Returns the full line content (useful for getting full webpack eval lines)
   */
  async getScriptLine(scriptId: string, lineNumber: number): Promise<string | null> {
    if (!this.state.connected) {
      return null;
    }

    const { Debugger } = this.client;

    try {
      const result = await Debugger.getScriptSource({ scriptId });
      const lines = result.scriptSource.split('\n');
      // lineNumber is 0-indexed from searchInContent
      if (lineNumber >= 0 && lineNumber < lines.length) {
        return lines[lineNumber];
      }
      return null;
    } catch (error) {
      return null;
    }
  }
}
