/**
 * Type definitions for the CDP debugger
 */

/**
 * Executes a registered tool by name (the replay/issues subsystems' way of
 * calling tools internally). The optional signal is forwarded to the tool's
 * handler; handlers that honour it THROW an abort-shaped error (see
 * utils/abort.ts isAbortError) rather than returning an isError response.
 * One shared type so the next parameter is not added in twelve places again.
 */
export type ExecuteToolCall = (
  toolName: string,
  params: Record<string, any>,
  abortSignal?: AbortSignal
) => Promise<any>;

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
  /**
   * Status of the breakpoint:
   * - 'resolved': Breakpoint is set and bound to a loaded script
   * - 'pending': Breakpoint is set but script hasn't loaded yet (will activate when script loads)
   */
  status?: 'resolved' | 'pending';
}

/**
 * DOM Breakpoint types (from CDP DOMDebugger.DOMBreakpointType)
 */
export type DOMBreakpointType = 'subtree-modified' | 'attribute-modified' | 'node-removed';

/**
 * DOM Breakpoint info - pauses when DOM node is modified
 */
export interface DOMBreakpointInfo {
  breakpointId: string;           // 'dom-bp-{counter}'
  type: 'dom';
  nodeId: number;
  domBreakpointType: DOMBreakpointType;
  selector: string;               // Original CSS selector for display/reference
}

/**
 * Event Listener Breakpoint info - pauses when event fires
 */
export interface EventListenerBreakpointInfo {
  breakpointId: string;           // 'event-bp-{counter}'
  type: 'event';
  eventName: string;              // e.g., 'click', 'submit', 'input'
  targetName?: string;            // Optional EventTarget interface filter
}

/**
 * XHR/Fetch Breakpoint info - pauses when network request matches URL
 */
export interface XHRBreakpointInfo {
  breakpointId: string;           // 'xhr-bp-{counter}'
  type: 'xhr';
  urlPattern: string;             // URL substring to match
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
