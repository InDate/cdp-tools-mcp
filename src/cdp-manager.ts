/**
 * CDP Connection Manager
 * Handles connection to Chrome DevTools Protocol (Chrome or Node.js)
 */

import CDP from 'chrome-remote-interface';
import type { BreakpointInfo, CallFrame, DebuggerState, RuntimeType } from './types.js';
import type { SourceMapHandler } from './sourcemap-handler.js';

export class CDPManager {
  private client: any = null;
  private state: DebuggerState = {
    connected: false,
    paused: false,
    breakpoints: new Map(),
  };
  private scriptIdToUrl: Map<string, string> = new Map();
  private urlToScriptId: Map<string, string> = new Map();
  private pauseResolvers: Array<() => void> = [];
  private sourceMapHandler: SourceMapHandler | null = null;

  constructor(sourceMapHandler?: SourceMapHandler) {
    this.sourceMapHandler = sourceMapHandler || null;
  }

  /**
   * Connect to a Chrome or Node.js debugger instance
   */
  async connect(host: string = 'localhost', port: number = 9222): Promise<void> {
    try {
      this.client = await CDP({ host, port });

      const { Debugger, Runtime } = this.client;

      // Enable the Debugger domain
      await Debugger.enable();
      await Runtime.enable();

      // Detect runtime type
      this.state.runtimeType = await this.detectRuntimeType();

      // Set up event listeners
      Debugger.scriptParsed((params: any) => {
        this.scriptIdToUrl.set(params.scriptId, params.url);
        this.urlToScriptId.set(params.url, params.scriptId);

        // Auto-load source map if available
        if (params.sourceMapURL && this.sourceMapHandler) {
          this.sourceMapHandler.loadSourceMapFromURL(params.url, params.sourceMapURL).catch((err) => {
            // Silently fail - source maps are optional
          });
        }
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

    // Try to set breakpoint by URL first
    const result = await Debugger.setBreakpointByUrl({
      url,
      lineNumber,
      columnNumber,
      condition,
    });

    const breakpointInfo: BreakpointInfo = {
      breakpointId: result.breakpointId,
      location: result.locations[0] || { scriptId: '', lineNumber, columnNumber },
      originalLocation: { url, lineNumber, columnNumber },
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
  async getVariables(
    callFrameId: string,
    includeGlobal: boolean = false,
    filter?: string,
    expandObjects: boolean = true,
    maxDepth: number = 2
  ): Promise<any[]> {
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

    const variables: any[] = [];
    const filterRegex = filter ? new RegExp(filter, 'i') : null;

    // Get variables from each scope
    for (const scope of callFrame.scopeChain) {
      // Skip global scope unless explicitly requested
      if (scope.type === 'global' && !includeGlobal) {
        continue;
      }

      const properties = await Runtime.getProperties({
        objectId: scope.object.objectId,
        ownProperties: true,
      });

      for (const prop of properties.result) {
        // Skip properties without values
        if (!prop.value) {
          continue;
        }

        // Apply filter if provided (only for global scope)
        if (scope.type === 'global' && filterRegex && !filterRegex.test(prop.name)) {
          continue;
        }

        variables.push({
          name: prop.name,
          value: await this.formatValue(prop.value, expandObjects, maxDepth),
          type: prop.value.type,
          scopeType: scope.type,
        });
      }
    }

    return variables;
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

    // Find the script ID for this URL
    const scriptId = this.urlToScriptId.get(url);
    if (!scriptId) {
      throw new Error(`Script not found for URL: ${url}. Make sure the script has been loaded/parsed.`);
    }

    // Get the full source code from CDP
    const result = await Debugger.getScriptSource({ scriptId });
    const fullSource = result.scriptSource;

    // Split into lines
    const lines = fullSource.split('\n');
    const totalLines = lines.length;

    // Determine the range
    const start = startLine ? Math.max(1, startLine) : 1;
    const end = endLine ? Math.min(totalLines, endLine) : (startLine ? Math.min(totalLines, startLine + 9) : totalLines);

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
      totalLines,
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

      // If expansion is disabled or we've hit max depth, return description
      if (!expandObjects || currentDepth >= maxDepth) {
        if (value.subtype === 'array') return `Array(${value.description})`;
        return value.description || value.className || 'Object';
      }

      // Expand object/array contents
      if (value.objectId) {
        try {
          const { Runtime } = this.client;
          const properties = await Runtime.getProperties({
            objectId: value.objectId,
            ownProperties: true,
          });

          if (value.subtype === 'array') {
            // For arrays, extract numeric indices and sort them
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
            // For objects, create a key-value map
            const objectProps: Record<string, any> = {};
            for (const prop of properties.result) {
              if (prop.value && !prop.name.startsWith('[[')) { // Skip internal properties
                objectProps[prop.name] = await this.formatValue(
                  prop.value,
                  expandObjects,
                  maxDepth,
                  currentDepth + 1
                );
              }
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
    if (value.type === 'function') return `[Function: ${value.description}]`;
    return String(value.value);
  }
}
