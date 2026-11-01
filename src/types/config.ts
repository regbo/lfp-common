/**
 * pynect - Core Configuration Types
 * Full configuration interface for pynect runtime initialization.
 */

import { availableParallelism } from 'os';
import type { AutoSyncMode } from '../config/project';

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

export interface VirtualenvConfig {
  /**
   * Must resolve to the repository-root `.venv` when provided.
   * @deprecated Pynect now always uses the Pyfig-managed repository `.venv`.
   */
  path?: string;
  /** @deprecated Declare Python dependencies in package.json pynect.requirements. */
  packages?: string[];
  /** @deprecated Use pynect sync or the root autoSync policy. */
  autoInstall?: boolean;
  /** @deprecated Configure uv through application-owned environment policy. */
  pipIndexUrl?: string;
  /** @deprecated Arbitrary install arguments are not accepted by project sync. */
  pipArgs?: string[];
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

export interface PynectConfig {
  /** Shut down the shared runtime when the Node.js or Bun process exits. Default: true. */
  autoShutdown?: boolean;

  /** Preferred Python executable used to create or validate the project `.venv`. */
  python?: string;

  /**
   * Python executable to check first as the base for the repository `.venv`.
   * It must expose the CPython embedding development files; package and
   * runtime operations still target the root `.venv` rather than this path.
   * @deprecated Use python instead.
   */
  pythonPath?: string;

  /** Accepted Python version range. Default: Pyfig's supported range. */
  requiresPython?: string;

  /** Repository root that owns `.venv`. Default: Pyfig project discovery. */
  projectRoot?: string;

  /** Allow Pyfig to install managed Python. Default: true. */
  installPython?: boolean;

  /** Allow Pyfig to install its pinned uv release. Default: true. */
  installUv?: boolean;

  /** Allow Pyfig to create the application-root `.venv`. Default: true. */
  createVirtualEnvironment?: boolean;

  /** @deprecated Use installPython instead. */
  autoInstallPython?: boolean;

  /** @deprecated Use installUv instead. */
  autoInstallUv?: boolean;

  /** @deprecated Use createVirtualEnvironment instead. */
  autoCreateVirtualEnvironment?: boolean;

  /** Managed Python version requested from uv. Default: '3.12'. */
  managedPython?: string;

  /** Pinned uv release used by the checksum-verified bootstrap. */
  uvVersion?: string;

  /** Synchronize the locked project environment when it is missing or stale. Default: 'never'. */
  autoSync?: AutoSyncMode;

  /** Project-relative Pynect lockfile. Default: 'pynect.lock'. */
  lockfile?: string;

  /**
   * Legacy root `.venv` compatibility settings. Package provisioning now uses
   * the application `pynect` manifest and `pynect sync`.
   */
  virtualenv?: VirtualenvConfig;

  /**
   * Thread pool configuration for Python execution.
   */
  threadPool?: ThreadPoolConfig;

  /**
   * Legacy shorthand for threadPool.size.
   * @deprecated Use threadPool.size instead.
   */
  threadPoolSize?: number;

  /**
   * Memory configuration for Python heap.
   */
  memory?: MemoryConfig;

  /**
   * Legacy shorthand for memory.limit.
   * @deprecated Use memory.limit instead.
   */
  memoryLimit?: string;

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
   * Legacy shorthand for profiling.enabled.
   * @deprecated Use profiling.enabled instead.
   */
  enableProfiling?: boolean;

  /**
   * Maximum queue wait before a Python call begins, in milliseconds.
   * This cannot interrupt running CPython code. Default: 0 (disabled).
   */
  callTimeout?: number;

  /** Cooperative timeout for async Python execution. Sync code requires isolation for a hard timeout. */
  executionTimeout?: number;

  /** Optional process-isolated, JSON-only calls with hard termination. */
  isolation?: IsolationConfig;

  /** Callable selection and optional Pydantic validation policy. */
  dispatcher?: DispatcherConfig;

  /** Expose raw Python eval, exec, contexts, and native addon access. Default: false. */
  allowUnsafeCode?: boolean;

  /** Permit runtime pip package installation. Default: false. */
  allowPackageInstall?: boolean;

  /** Include Python tracebacks in JavaScript errors. Default: false. */
  includeTracebacks?: boolean;

  /**
   * GIL (Global Interpreter Lock) management configuration.
   */
  gil?: GILConfig;

  /**
   * Additional Python sys.path entries.
   * Inserted at sys.path[0] in order.
   */
  pythonPath_extra?: string[];

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
  autoShutdown: boolean;
  pythonExecutable: string;
  pythonHome: string;
  projectRoot: string;
  requiresPython: string;
  autoInstallPython: boolean;
  autoInstallUv: boolean;
  autoCreateVirtualEnvironment: boolean;
  managedPython: string;
  uvVersion: string;
  autoSync: AutoSyncMode;
  lockfile: string;
  threadPoolSize: number;
  maxQueueSize: number;
  idleTimeout: number;
  memoryLimit: string;
  gcThreshold: string;
  leakDetection: boolean;
  logLevel: LogLevel;
  callTimeout: number;
  executionTimeout: number;
  isolation: Required<IsolationConfig>;
  dispatcher: Required<DispatcherConfig>;
  allowUnsafeCode: boolean;
  allowPackageInstall: boolean;
  includeTracebacks: boolean;
  gil: Required<GILConfig>;
  profilingEnabled: boolean;
  profilingFile?: string;
  profilingSamplingInterval: number;
  sharedArrayBuffer: boolean;
  lazyResolution: boolean;
  env: Record<string, string>;
  pythonPathExtra: string[];
}

export function resolveConfig(config: PynectConfig = {}): ResolvedPynectConfig {
  return {
    autoShutdown: config.autoShutdown ?? true,
    pythonExecutable: config.python ?? config.pythonPath ?? 'python3',
    pythonHome: '',
    projectRoot: config.projectRoot ?? process.cwd(),
    requiresPython: config.requiresPython ?? '>=3.10.0 <4.0.0',
    autoInstallPython: config.installPython ?? config.autoInstallPython ?? true,
    autoInstallUv: config.installUv ?? config.autoInstallUv ?? true,
    autoCreateVirtualEnvironment: config.createVirtualEnvironment ?? config.autoCreateVirtualEnvironment ?? true,
    managedPython: config.managedPython ?? '3.12',
    uvVersion: config.uvVersion ?? '0.13.6',
    autoSync: config.autoSync ?? 'never',
    lockfile: config.lockfile ?? 'pynect.lock',
    threadPoolSize: config.threadPool?.size ?? config.threadPoolSize ?? Math.max(4, availableParallelism()),
    maxQueueSize: config.threadPool?.maxQueueSize ?? 1000,
    idleTimeout: config.threadPool?.idleTimeout ?? 30000,
    memoryLimit: config.memory?.limit ?? config.memoryLimit ?? '2GB',
    gcThreshold: config.memory?.gcThreshold ?? '1GB',
    leakDetection: config.memory?.leakDetection ?? false,
    logLevel: config.logLevel ?? 'warn',
    callTimeout: config.callTimeout ?? 0,
    executionTimeout: config.executionTimeout ?? 0,
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
    allowPackageInstall: config.allowPackageInstall ?? false,
    includeTracebacks: config.includeTracebacks ?? false,
    gil: {
      releaseInterval: config.gil?.releaseInterval ?? 5000,
      acquireTimeout: config.gil?.acquireTimeout ?? 10000,
    },
    profilingEnabled: config.profiling?.enabled ?? config.enableProfiling ?? false,
    profilingFile: config.profiling?.outputFile,
    profilingSamplingInterval: config.profiling?.samplingInterval ?? 1000,
    sharedArrayBuffer: config.experimental?.sharedArrayBuffer ?? true,
    lazyResolution: config.experimental?.lazyResolution ?? true,
    env: config.env ?? {},
    pythonPathExtra: config.pythonPath_extra ?? [],
  };
}
