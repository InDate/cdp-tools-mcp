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

export interface DebuggerState {
  connected: boolean;
  paused: boolean;
  currentCallFrames?: CallFrame[];
  breakpoints: Map<string, BreakpointInfo>;
}
