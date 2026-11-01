/**
 * pynect - Main Entry Point
 *
 * Run Python libraries from Node.js as if they were Native.
 * Embeds CPython in-process via N-API addon with full TypeScript types,
 * Proxy-based API, async/await support, and Next.js integration.
 *
 * @example
 * ```typescript
 * import { init, py } from 'pynect';
 *
 * await init({
 * project: {
 * dependencies: ['pandas', 'numpy'],
 * },
 * tool: { pynect: { autoSync: 'if-missing' } },
 * });
 *
 * const pd = await py.import('pandas');
 * const df = await pd.read_csv('data.csv');
 * const result = await df.describe().to_dict('records');
 * ```
 */

import { PyRuntime } from './core/py-runtime';
import { Logger } from './utils/logger';
import { PynectNotInitializedError } from './utils/error-translator';
import type { PynectConfig } from './types/config';
import type { PyProxyInterface } from './types/python';
import type { IsolatedCallOptions } from './core/isolated-worker';
import { resolveExposedModule } from './env/project-environment';
import { withPynectLock } from './utils/locking';

// Singleton Runtime Management

let _runtime: PyRuntime | null = null;
let _autoShutdownEnabled = true;

const _logger = new Logger('pynect');

// Main py Object (Proxy over PyRuntime)

/**
 * The main `py` object - a proxy over the PyRuntime singleton.
 * Provides access to all PyRuntime methods after initialization.
 *
 * @throws {PynectNotInitializedError} if accessed before calling `init()`
 */
export const py: PyRuntime = new Proxy({} as PyRuntime, {
  get(_target, prop: string | symbol): unknown {
    if (!_runtime) {
      // Provide helpful error for common misuse
      if (prop === 'then') {
        // Prevent silent "awaiting py" mistakes
        return undefined;
      }
      throw new PynectNotInitializedError(
        `Cannot access py.${String(prop)} because Pynect is not initialized. ` +
        `Call 'await init()' before using 'py'.`
      );
    }
    const value = (_runtime as unknown as Record<string | symbol, unknown>)[prop];
    if (typeof value === 'function') {
      return value.bind(_runtime);
    }
    return value;
  },

  set(_target, prop: string | symbol, value: unknown): boolean {
    if (!_runtime) {
      throw new PynectNotInitializedError('Pynect is not initialized.');
    }
    (_runtime as unknown as Record<string | symbol, unknown>)[prop] = value;
    return true;
  },

  has(_target, prop: string | symbol): boolean {
    if (!_runtime) {return false;}
    return prop in _runtime;
  },
});

// Lifecycle Functions

/**
 * Initialize the pynect runtime.
 * Must be called before using `py` or any other pynect API.
 *
 * Calling `init()` multiple times is safe - subsequent calls are no-ops
 * unless `shutdown()` was called first, or `force: true` is passed.
 *
 * @param config - pynect configuration options
 * @param options - Additional initialization options
 * @returns Promise that resolves when Python is ready
 *
 * @example
 * ```typescript
 * await init({
 * project: { dependencies: ['pandas'] },
 * tool: { pynect: { autoSync: 'if-missing' } },
 * logLevel: 'info',
 * });
 * ```
 */
export async function init(
  config?: PynectConfig,
  options?: { force?: boolean }
): Promise<void> {
  await withPynectLock(
    { operation: 'init' },
    async () => {
      if (_runtime && !options?.force) {
        _logger.debug('Pynect already initialized; skipping');
        return;
      }
      if (_runtime && options?.force) await _doShutdown();
      await _doInit(config);
    },
    undefined,
    {
      key: 'pynect-runtime-lifecycle',
      name: 'Pynect runtime lifecycle',
      namespace: 'pynect',
      scope: { memory: true, worker: false, flock: false, poll: false },
    },
  );
}

async function _doInit(config?: PynectConfig): Promise<void> {
  _logger.info('Initializing Pynect runtime');
  const startTime = performance.now();

  try {
    _runtime = await PyRuntime.create(config);
    _autoShutdownEnabled = _runtime.getConfig().autoShutdown;
    if (_autoShutdownEnabled) {_registerCleanup();}
    const elapsed = (performance.now() - startTime).toFixed(0);
    _logger.success(`Pynect runtime ready in ${elapsed}ms`);
  } catch (err) {
    _runtime = null;
    _logger.error('Failed to initialize Pynect runtime', err);
    throw err;
  }
}

/**
 * Shut down the pynect runtime and release all Python resources.
 * After calling this, `py` is no longer accessible until `init()` is called again.
 *
 * @example
 * ```typescript
 * await shutdown();
 * ```
 */
export async function shutdown(): Promise<void> {
  await withPynectLock(
    { operation: 'shutdown' },
    async () => _doShutdown(),
    undefined,
    {
      key: 'pynect-runtime-lifecycle',
      name: 'Pynect runtime lifecycle',
      namespace: 'pynect',
      scope: { memory: true, worker: false, flock: false, poll: false },
    },
  );
}

async function _doShutdown(): Promise<void> {
  if (!_runtime) {
    _logger.debug('Pynect is not initialized; nothing to shut down');
    return;
  }

  _logger.info('Shutting down Pynect runtime');
  const runtime = _runtime;

  try {
    await runtime.shutdown();
    _runtime = null;
    _logger.success('Pynect runtime shut down');
  } catch (err) {
    _logger.error('Error during Pynect shutdown', err);
    throw err;
  }
}

/**
 * Check if pynect is initialized and ready to use.
 */
export function isInitialized(): boolean {
  return _runtime !== null && _runtime.isRunning();
}

/**
 * Get the current PyRuntime instance.
 * @throws {PynectNotInitializedError} if not initialized
 */
export function getRuntime(): PyRuntime {
  if (!_runtime) {
    throw new PynectNotInitializedError();
  }
  return _runtime;
}

// Convenience API

/**
 * Initialize the default runtime when needed, then import a Python module.
 * Call `init(config)` first when custom runtime settings are required.
 *
 * @example
 * ```typescript
 * const np = await importModule('numpy');
 * const arr = await np.array([1, 2, 3]);
 * ```
 */
/** Module types contributed by `pynect codegen`. */
export interface PynectModules {}

export function importModule<Name extends keyof PynectModules & string>(
  moduleName: Name,
): Promise<PynectModules[Name]>;
export function importModule(moduleName: string): Promise<PyProxyInterface>;
export async function importModule(moduleName: string): Promise<PyProxyInterface> {
  if (!_runtime) {await init();}
  if (!_runtime) {throw new PynectNotInitializedError();}
  const exposed = moduleName.includes(':')
    ? resolveExposedModule(moduleName, _runtime.getConfig().projectRoot)
    : undefined;
  if (moduleName.includes(':') && !exposed) {
    throw new Error(`Unknown Pynect module id: ${moduleName}`);
  }
  return _runtime.import(exposed?.import ?? moduleName);
}

/** Call a JSON-compatible function through the optional killable Python worker. */
export async function callIsolated<T = unknown>(
  moduleName: string,
  functionName: string,
  args: unknown[] = [],
  options: IsolatedCallOptions = {},
): Promise<T> {
  if (!_runtime) {throw new PynectNotInitializedError();}
  return _runtime.callIsolated<T>(moduleName, functionName, args, options);
}

/**
 * Evaluate a Python expression and return the result.
 * Shorthand for `py.eval(expression)`.
 *
 * @example
 * ```typescript
 * const result = await evalPython('1 + 2 + 3');
 * // result === 6
 * ```
 */
export async function evalPython(expression: string): Promise<unknown> {
  if (!_runtime) {throw new PynectNotInitializedError();}
  return _runtime.eval(expression);
}

/**
 * Execute Python code (statements, not expressions).
 * Shorthand for `py.exec(code)`.
 *
 * @example
 * ```typescript
 * await execPython(`
 * import sys
 * print(f"Python {sys.version}")
 * `);
 * ```
 */
export async function execPython(code: string): Promise<void> {
  if (!_runtime) {throw new PynectNotInitializedError();}
  return _runtime.exec(code);
}

/**
 * Run a Python script file.
 */
export async function runFile(filePath: string): Promise<unknown> {
  if (!_runtime) {throw new PynectNotInitializedError();}
  return _runtime.runFile(filePath);
}

/**
 * Install Python packages into the configured virtualenv.
 *
 * @example
 * ```typescript
 * await installPackages(['pandas', 'numpy>=1.24.0', 'scikit-learn']);
 * ```
 */
export async function installPackages(packages: string[]): Promise<void> {
  if (!_runtime) {throw new PynectNotInitializedError();}
  return _runtime.installPackages(packages);
}

/**
 * Get memory statistics for the Python heap.
 */
export async function getMemoryStats(): Promise<{
  pythonHeapBytes: number;
  pythonHeapPeakBytes: number;
  trackedObjects: number;
  pendingCallbacks: number;
}> {
  if (!_runtime) {throw new PynectNotInitializedError();}
  return _runtime.getMemoryStats();
}

/**
 * Trigger Python garbage collection.
 */
export async function collectGarbage(): Promise<void> {
  if (!_runtime) {throw new PynectNotInitializedError();}
  return _runtime.collectGarbage();
}

// Auto-cleanup on process exit

let _cleanupRegistered = false;

function _registerCleanup(): void {
  if (_cleanupRegistered) {return;}
  _cleanupRegistered = true;

  const cleanup = (): Promise<void> => {
    if (!_autoShutdownEnabled || !_runtime) {return Promise.resolve();}
    return shutdown().catch(() => undefined);
  };

  process.on('beforeExit', cleanup);
  process.on('exit', () => {
    if (_autoShutdownEnabled && _runtime) {
      try {
        _runtime.shutdownSync();
      } catch {
        // Process exit cleanup is best-effort.
      }
    }
  });
}

// Exports

// Core
export { PyRuntime } from './core/py-runtime';
export { PyProxy, PYNECT_WITH_OPTIONS } from './core/py-proxy';
export type { PynectFunction } from './core/py-proxy';
export { PyModule } from './core/py-module';
export { PyCallable } from './core/py-callable';
export { PyIterator } from './core/py-iterator';
export { PyContext } from './core/py-context';
export { IsolatedWorker } from './core/isolated-worker';
export type { IsolatedCallOptions } from './core/isolated-worker';

// Serialization
export { Serializer } from './serialization/serializer';
export { NumpyBridge } from './serialization/numpy-bridge';
export { DataFrameBridge } from './serialization/data-frame-bridge';

// Error types
export {
  PythonError,
  PythonValueError,
  PythonTypeError,
  PythonKeyError,
  PythonIndexError,
  PythonAttributeError,
  PythonImportError,
  PythonModuleNotFoundError,
  PythonFileNotFoundError,
  PythonPermissionError,
  PythonRuntimeError,
  PythonMemoryError,
  PythonStopIteration,
  PythonTimeoutError,
  PynectNotInitializedError,
  PynectShutdownError,
  translatePythonError,
  isPythonError,
  isPythonErrorOfType,
} from './utils/error-translator';

// Environment management
export { PythonDetector } from './env/python-detector';
export { VenvManager } from './env/venv-manager';
export { PackageInstaller } from './env/package-installer';
export {
  createProjectPlan,
  discoverPynectContributions,
  moduleDispatcherIncludes,
  resolveExposedModule,
  syncProject,
  validateProjectEnvironment,
} from './env/project-environment';
export { CURRENT_PYNECT_SCHEMA_VERSION, resolveProjectConfig } from './config/project';

// Plugins
export { PluginManager } from './plugins/plugin-manager';

// Types
export type {
  PynectConfig,
  ResolvedPynectConfig,
  VirtualenvConfig,
  IsolationConfig,
  DispatcherConfig,
  LogLevel,
  PyObjectId,
  PyTypeInfo,
  PyParamInfo,
  PyCallableInfo,
  PyClassInfo,
  PyModuleInspection,
  SerializedFormat,
  SerializedValue,
  PyCallResult,
  PyErrorInfo,
  DataFrameResult,
  SeriesResult,
  NumPyArrayResult,
  PyProxyInterface,
  AttributePath,
  NativeAddon,
  PyCallOptions,
} from './types/index';
export type {
  AutoSyncMode,
  CanonicalPynectPackageManifest,
  PynectModuleManifest,
  PynectPackageManifest,
  PynectProjectTable,
  PynectToolTable,
  PynectUvTable,
  ProjectConfigOverrides,
  ResolvedProjectConfig,
} from './config/project';
export type {
  ExposedModule,
  PynectContribution,
  PynectEnvironmentState,
  PynectProjectPlan,
  SyncProjectOptions,
  SyncProjectResult,
} from './env/project-environment';

// Default export
export default {
  init,
  shutdown,
  isInitialized,
  getRuntime,
  py,
  import: importModule,
  callIsolated,
  eval: evalPython,
  exec: execPython,
  runFile,
  installPackages,
  getMemoryStats,
  collectGarbage,
};
