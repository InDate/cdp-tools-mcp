/**
 * Type definitions for the CDP debugger
 */

export interface BreakpointInfo {
  breakpointId: string;
  location: {
    scriptId: string;
    lineNumber: number;
    columnNumber?: number;
  };
  originalLocation?: {
    url: string;
    lineNumber: number;
    columnNumber?: number;
  };
  isLogpoint?: boolean;
}

export interface CallFrame {
  callFrameId: string;
  functionName: string;
  location: {
    scriptId: string;
    lineNumber: number;
    columnNumber: number;
  };
  url: string;
  scopeChain: Scope[];
}

export interface Scope {
  type: string;
  object: {
    objectId: string;
    type: string;
    className?: string;
  };
  name?: string;
}

export interface Variable {
  name: string;
  value: string;
  type: string;
}

export type RuntimeType = 'chrome' | 'node' | 'unknown';

export interface DebuggerState {
  connected: boolean;
  paused: boolean;
  currentCallFrames?: CallFrame[];
  breakpoints: Map<string, BreakpointInfo>;
  runtimeType?: RuntimeType;
}

/**
 * CDP Runtime.consoleAPICalled event parameters
 */
export interface CDPConsoleMessage {
  type: 'log' | 'debug' | 'info' | 'error' | 'warning' | 'dir' | 'dirxml' | 'table' | 'trace' | 'clear' | 'startGroup' | 'startGroupCollapsed' | 'endGroup' | 'assert' | 'profile' | 'profileEnd' | 'count' | 'timeEnd';
  args: Array<{
    type: string;
    subtype?: string;
    className?: string;
    value?: any;
    description?: string;
    objectId?: string;
    unserializableValue?: string;
    preview?: {
      type: string;
      description?: string;
      overflow?: boolean;
      properties?: Array<{
        name: string;
        type: string;
        value?: string;
      }>;
    };
  }>;
  executionContextId: number;
  timestamp: number;
  stackTrace?: {
    callFrames: Array<{
      functionName: string;
      scriptId: string;
      url: string;
      lineNumber: number;
      columnNumber: number;
    }>;
  };
}

export type ConsoleMessageCallback = (message: CDPConsoleMessage) => void;
