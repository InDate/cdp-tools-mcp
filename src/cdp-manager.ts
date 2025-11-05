/**
 * CDP Connection Manager
 * Handles connection to Chrome DevTools Protocol (Chrome or Node.js)
 */

import CDP from 'chrome-remote-interface';
import type { BreakpointInfo, CallFrame, DebuggerState } from './types.js';

export class CDPManager {
  private client: any = null;
  private state: DebuggerState = {
    connected: false,
    paused: false,
    breakpoints: new Map(),
  };
  private scriptIdToUrl: Map<string, string> = new Map();
  private urlToScriptId: Map<string, string> = new Map();

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

      // Set up event listeners
      Debugger.scriptParsed((params: any) => {
        this.scriptIdToUrl.set(params.scriptId, params.url);
        this.urlToScriptId.set(params.url, params.scriptId);
      });

      Debugger.paused((params: any) => {
        this.state.paused = true;
        this.state.currentCallFrames = params.callFrames;
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
   * Set a breakpoint at a specific file and line
   */
  async setBreakpoint(url: string, lineNumber: number, columnNumber?: number): Promise<BreakpointInfo> {
    if (!this.state.connected) {
      throw new Error('Not connected to debugger');
    }

    const { Debugger } = this.client;

    // Try to set breakpoint by URL first
    const result = await Debugger.setBreakpointByUrl({
      url,
      lineNumber,
      columnNumber,
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
  async getVariables(callFrameId: string): Promise<any[]> {
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

    // Get variables from each scope
    for (const scope of callFrame.scopeChain) {
      const properties = await Runtime.getProperties({
        objectId: scope.object.objectId,
        ownProperties: true,
      });

      for (const prop of properties.result) {
        variables.push({
          name: prop.name,
          value: this.formatValue(prop.value),
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
  async evaluateExpression(expression: string, callFrameId?: string): Promise<any> {
    if (!this.state.connected) {
      throw new Error('Not connected to debugger');
    }

    const { Debugger } = this.client;

    if (callFrameId) {
      const result = await Debugger.evaluateOnCallFrame({
        callFrameId,
        expression,
      });
      return this.formatValue(result.result);
    } else {
      const { Runtime } = this.client;
      const result = await Runtime.evaluate({ expression });
      return this.formatValue(result.result);
    }
  }

  /**
   * Format a CDP RemoteObject value for display
   */
  private formatValue(value: any): string {
    if (value.type === 'undefined') return 'undefined';
    if (value.type === 'string') return `"${value.value}"`;
    if (value.type === 'number' || value.type === 'boolean') return String(value.value);
    if (value.type === 'object') {
      if (value.subtype === 'null') return 'null';
      if (value.subtype === 'array') return `Array(${value.description})`;
      return value.description || value.className || 'Object';
    }
    if (value.type === 'function') return `[Function: ${value.description}]`;
    return String(value.value);
  }
}
