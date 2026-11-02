/**
 * pynect - Core Configuration Types
 * Full configuration interface for a Pynect Python bridge.
 */

import { availableParallelism } from 'os';
import { DEFAULT_REQUIRES_UV } from 'pyfig';
import type { PynectPackageManifest } from '../config/project';

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';
export type ValidationMode = 'auto' | 'required' | 'off';

export interface DispatcherConfig {
  /** Glob patterns restricting callable access when non-empty. */
  include?: string[];
  /** Glob patterns that always deny matching modules or callables. */
  exclude?: string[];
  /** Require complete parameter and return type hints. */
  typedOnly?: boolean;
  /** Require the @pynect.export decorator. */
  exportedOnly?: boolean;
  /** Validate with Pydantic when available, require it, or disable it. */
  validation?: ValidationMode;
}

export interface GILConfig {
  /**
   * How often to release the GIL during long Python operations (microseconds).
   * Lower values improve Node.js responsiveness at cost of Python throughput.
   * Default: 5000 (5ms)
   */
  releaseInterval?: number;
  /**
   * Maximum time to wait for GIL acquisition before timing out (milliseconds).
   * Default: 10000 (10s)
   */
  acquireTimeout?: number;
}

export interface ThreadPoolConfig {
  /** Number of worker threads. Default: max(4, available CPU cores). */
  size?: number;
  /** Max queue depth before backpressure is applied. Default: 1000 */
  maxQueueSize?: number;
  /** Thread idle timeout before shrinking pool (ms). Default: 30000 */
  idleTimeout?: number;
}

export interface IsolationConfig {
  /** Enable the JSON-only child-process call surface. Default: false. */
  enabled?: boolean;
  /** Default hard timeout for isolated calls in milliseconds. Default: 30000. */
  timeout?: number;
  /** Working directory for the isolated Python worker. Default: process.cwd(). */
  cwd?: string;
}

export interface CallbackConfig {
  /**
   * Maximum nested Python -> JavaScript -> Python callback depth.
   * By default Pynect uses the embedded interpreter's active recursion limit.
   */
  maxDepth?: number;
}

export interface MemoryConfig {
  /** Maximum Python heap size (e.g. '2GB', '512MB'). Default: '2GB' */
  limit?: string;
  /** Trigger Python GC when heap exceeds this threshold. Default: '1GB' */
  gcThreshold?: string;
  /** Enable leak detection in debug builds. Default: false */
  leakDetection?: boolean;
}

export interface ProfilingConfig {
  /** Enable CPU profiling. Default: false */
  enabled?: boolean;
  /** Output file for profile data */
  outputFile?: string;
  /** Sampling interval (microseconds). Default: 1000 */
  samplingInterval?: number;
}

export interface PynectConfig extends PynectPackageManifest {
  /** Close the bridge when the Node.js or Bun process exits. Default: true. */
  autoClose?: boolean;

  /** Application root used for Pyfig environment ownership. Usually discovered automatically. */
  projectRoot?: string;

  /**
   * Thread pool configuration for Python execution.
   */
  threadPool?: ThreadPoolConfig;

  /**
   * Memory configuration for Python heap.
   */
  memory?: MemoryConfig;

  /**
   * Log level for pynect internal logging.
   * Default: 'warn'
   */
  logLevel?: LogLevel;

  /**
   * Profiling configuration.
   */
  profiling?: ProfilingConfig;

  /**
   * Maximum queue wait before a Python call begins, in milliseconds.
   * This cannot interrupt running CPython code. Default: 0 (disabled).
   */
  callTimeout?: number;

  /** Cooperative timeout for async Python execution. Sync code requires isolation for a hard timeout. */
  executionTimeout?: number;

  /** Optional process-isolated, JSON-only calls with hard termination. */
  isolation?: IsolationConfig;

  /** Registered JavaScript callback behavior. */
  callbacks?: CallbackConfig;

  /** Callable selection and optional Pydantic validation policy. */
  dispatcher?: DispatcherConfig;

  /** Expose raw Python eval, exec, contexts, and native addon access. Default: false. */
  allowUnsafeCode?: boolean;

  /** Include Python tracebacks in JavaScript errors. Default: false. */
  includeTracebacks?: boolean;

  /**
   * GIL (Global Interpreter Lock) management configuration.
   */
  gil?: GILConfig;

  /** Additional Python sys.path entries, inserted at sys.path[0] in order. */
  pythonModulePaths?: string[];

  /**
   * Environment variables to set for the Python interpreter.
   */
  env?: Record<string, string>;

  /**
   * Enable experimental features. Use with caution.
   */
  experimental?: {
    /** Use SharedArrayBuffer for NumPy transfers. Default: true */
    sharedArrayBuffer?: boolean;
    /** Lazy attribute resolution. Default: true */
    lazyResolution?: boolean;
  };
}

/**
 * Resolved and normalized configuration (all fields filled with defaults).
 */
export interface ResolvedPynectConfig {
  autoClose: boolean;
  pythonExecutable: string;
  pythonHome: string;
  projectRoot: string;
  requiresPython: string;
  installPython: boolean;
  installUv: boolean;
  createVirtualEnvironment: boolean;
  managedPython: string;
  requiresUv: string;
  threadPoolSize: number;
  maxQueueSize: number;
  idleTimeout: number;
  memoryLimit: string;
  gcThreshold: string;
  leakDetection: boolean;
  logLevel: LogLevel;
  callTimeout: number;
  executionTimeout: number;
  callbackMaxDepth: number;
  isolation: Required<IsolationConfig>;
  dispatcher: Required<DispatcherConfig>;
  allowUnsafeCode: boolean;
  includeTracebacks: boolean;
  gil: Required<GILConfig>;
  profilingEnabled: boolean;
  profilingFile?: string;
  profilingSamplingInterval: number;
  sharedArrayBuffer: boolean;
  lazyResolution: boolean;
  env: Record<string, string>;
  pythonModulePaths: string[];
}

export function resolveConfig(config: PynectConfig = {}): ResolvedPynectConfig {
  const callbackMaxDepth = config.callbacks?.maxDepth ?? 0;
  if (!Number.isSafeInteger(callbackMaxDepth) ||
    (config.callbacks?.maxDepth !== undefined && callbackMaxDepth <= 0)) {
    throw new TypeError('callbacks.maxDepth must be a positive integer when provided.');
  }
  return {
    autoClose: config.autoClose ?? true,
    pythonExecutable: config.tool?.pynect?.python ?? 'python3',
    pythonHome: '',
    projectRoot: config.projectRoot ?? process.cwd(),
    requiresPython: config.project?.['requires-python'] ?? '>=3.10.0 <4.0.0',
    installPython: config.tool?.pynect?.installPython ?? true,
    installUv: config.tool?.pynect?.installUv ?? true,
    createVirtualEnvironment: config.tool?.pynect?.createVirtualEnvironment ?? true,
    managedPython: config.tool?.pynect?.managedPython ?? '3.12',
    requiresUv: config.tool?.pynect?.requiresUv ?? DEFAULT_REQUIRES_UV,
    threadPoolSize: config.threadPool?.size ?? Math.max(4, availableParallelism()),
    maxQueueSize: config.threadPool?.maxQueueSize ?? 1000,
    idleTimeout: config.threadPool?.idleTimeout ?? 30000,
    memoryLimit: config.memory?.limit ?? '2GB',
    gcThreshold: config.memory?.gcThreshold ?? '1GB',
    leakDetection: config.memory?.leakDetection ?? false,
    logLevel: config.logLevel ?? 'warn',
    callTimeout: config.callTimeout ?? 0,
    executionTimeout: config.executionTimeout ?? 0,
    callbackMaxDepth,
    isolation: {
      enabled: config.isolation?.enabled ?? false,
      timeout: config.isolation?.timeout ?? 30000,
      cwd: config.isolation?.cwd ?? process.cwd(),
    },
    dispatcher: {
      include: config.dispatcher?.include ?? [],
      exclude: config.dispatcher?.exclude ?? [],
      typedOnly: config.dispatcher?.typedOnly ?? false,
      exportedOnly: config.dispatcher?.exportedOnly ?? false,
      validation: config.dispatcher?.validation ?? 'auto',
    },
    allowUnsafeCode: config.allowUnsafeCode ?? false,
    includeTracebacks: config.includeTracebacks ?? false,
    gil: {
      releaseInterval: config.gil?.releaseInterval ?? 5000,
      acquireTimeout: config.gil?.acquireTimeout ?? 10000,
    },
    profilingEnabled: config.profiling?.enabled ?? false,
    profilingFile: config.profiling?.outputFile,
    profilingSamplingInterval: config.profiling?.samplingInterval ?? 1000,
    sharedArrayBuffer: config.experimental?.sharedArrayBuffer ?? true,
    lazyResolution: config.experimental?.lazyResolution ?? true,
    env: config.env ?? {},
    pythonModulePaths: config.pythonModulePaths ?? [],
  };
}
