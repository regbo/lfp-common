/**
 * pynect - Native Addon TypeScript Interface
 * Type declarations for the C++ N-API addon.
 * These map exactly to the exported functions in pynect_addon.cpp.
 */

import type {
  SerializedValue,
  PyCallResult,
  PyIteratorNext,
  PyTypeInfo,
  AttributePath,
} from './python';

export interface AddonInitOptions {
  /** Path to Python home directory */
  pythonHome: string;
  /** Path to Python executable */
  pythonExecutable: string;
  /** Thread pool size */
  threadPoolSize: number;
  /** Max thread queue size */
  maxQueueSize: number;
  /** GIL release interval (microseconds) */
  gilReleaseInterval: number;
  /** Call timeout (milliseconds) */
  callTimeout: number;
  /** Additional Python sys.path entries */
  pythonPathExtra: string[];
  /** Environment variables */
  env: Record<string, string>;
  /** Enable profiling */
  enableProfiling: boolean;
  /** Include Python tracebacks in JavaScript errors */
  includeTracebacks: boolean;
}

export interface AddonImportResult {
  objectId: number;
  success: boolean;
  error?: string;
}

export interface AddonAttributeResult {
  success: boolean;
  value?: SerializedValue;
  objectId?: number;
  isCallable: boolean;
  isObject: boolean;
  error?: string;
}

export interface AddonCallOptions {
  /** Positional arguments */
  args: SerializedValue[];
  /** Keyword arguments */
  kwargs: Record<string, SerializedValue>;
  /** Call timeout override (ms) */
  timeout?: number;
  /** Cooperative timeout for async Python execution (ms). */
  executionTimeout?: number;
  /** Unique key used for cancellation. */
  requestId?: string;
}

export interface PyCallOptions {
  /** Cancel a queued or asynchronous Python call. */
  signal?: AbortSignal;
  /** Override the queue timeout for this call (ms). */
  queueTimeout?: number;
  /** Override the cooperative async execution timeout for this call (ms). */
  executionTimeout?: number;
}

export interface AddonIteratorResult {
  iteratorId: number;
  success: boolean;
  error?: string;
}

export interface AddonMemoryStats {
  pythonHeapBytes: number;
  pythonHeapPeakBytes: number;
  trackedObjects: number;
  pendingCallbacks: number;
  threadPoolActive: number;
  threadPoolQueued: number;
}

export interface AddonProfilingReport {
  totalCalls: number;
  totalTimeMs: number;
  avgCallTimeMs: number;
  peakCallTimeMs: number;
  callsByModule: Record<string, number>;
  callsByFunction: Record<string, number>;
}

/**
 * The full interface of the compiled C++ addon module.
 * All async methods return Promises (resolved on libuv callback).
 */
export interface NativeAddon {
  // Lifecycle
  initializePython(options: AddonInitOptions): Promise<void>;
  finalizePython(): Promise<void>;
  isInitialized(): boolean;

  // Module Import
  importModule(moduleName: string): Promise<AddonImportResult>;
  reloadModule(objectId: number): Promise<AddonImportResult>;

  // Attribute Access
  getAttribute(objectId: number, name: string): Promise<AddonAttributeResult>;
  getAttributePath(objectId: number, path: AttributePath): Promise<AddonAttributeResult>;
  setAttribute(objectId: number, name: string, value: SerializedValue): Promise<boolean>;
  hasAttribute(objectId: number, name: string): Promise<boolean>;
  deleteAttribute(objectId: number, name: string): Promise<boolean>;

  // Function Calls
  callFunction(
    objectId: number,
    path: AttributePath,
    options: AddonCallOptions
  ): Promise<PyCallResult>;
  callMethod(
    objectId: number,
    methodName: string,
    options: AddonCallOptions
  ): Promise<PyCallResult>;
  cancelCall(requestId: string): Promise<unknown>;

  // Object Inspection
  getTypeInfo(objectId: number): Promise<PyTypeInfo>;
  getObjectValue(objectId: number): Promise<SerializedValue>;
  getObjectRepr(objectId: number): Promise<string>;
  getObjectLength(objectId: number): Promise<number>;
  getObjectKeys(objectId: number): Promise<string[]>;

  // Iterator Support
  createIterator(objectId: number, path: AttributePath): Promise<AddonIteratorResult>;
  iteratorNext(iteratorId: number): Promise<PyIteratorNext>;
  destroyIterator(iteratorId: number): Promise<void>;

  // Raw Python Execution
  runPythonCode(code: string, globals?: SerializedValue): Promise<SerializedValue>;
  runPythonFile(filePath: string): Promise<SerializedValue>;
  evalPython(expression: string): Promise<SerializedValue>;

  // Object Lifecycle
  incRef(objectId: number): void;
  decRef(objectId: number): void;
  collectGarbage(): Promise<void>;

  // Memory & Diagnostics
  getMemoryStats(): AddonMemoryStats;
  getProfilingReport(): AddonProfilingReport;
  resetProfilingStats(): void;

  // Threading
  setThreadPoolSize(size: number): Promise<void>;
  getThreadPoolStats(): { active: number; queued: number; total: number };
}

/**
 * Loads the native addon, trying prebuilds first then build directory.
 */
export function loadNativeAddon(): NativeAddon {
  // Try prebuilt binary first (faster, no build tools needed)
  try {
    // node-gyp-build handles platform/arch detection automatically
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const build = require('node-gyp-build');
    return build(__dirname + '/../../') as NativeAddon;
  } catch {
    // Fall back to explicit build path
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require('../../build/Release/pynect_addon.node') as NativeAddon;
    } catch {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require('../../build/Debug/pynect_addon.node') as NativeAddon;
    }
  }
}
