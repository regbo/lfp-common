/** Typed Python calls from Node.js and Bun through one explicitly owned bridge. */

export { createPythonBridge } from './core/python-bridge';
export type { PythonBridge } from './core/python-bridge';

/** Module types contributed by `pynect codegen`. */
export interface PynectModules {}

export { PyProxy, PYNECT_WITH_OPTIONS } from './core/py-proxy';
export type { PynectFunction } from './core/py-proxy';
export { PyModule } from './core/py-module';
export { PyCallable } from './core/py-callable';
export type { Awaitable, PynectCallback } from './core/pynect-callback';
export { PyIterator } from './core/py-iterator';
export { PyContext } from './core/py-context';
export { IsolatedWorker } from './core/isolated-worker';
export type { IsolatedCallOptions } from './core/isolated-worker';

export { Serializer } from './serialization/serializer';
export { NumpyBridge } from './serialization/numpy-bridge';
export { DataFrameBridge } from './serialization/data-frame-bridge';

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
  PynectClosedError,
  translatePythonError,
  isPythonError,
  isPythonErrorOfType,
} from './utils/error-translator';

export {
  createProjectPlan,
  discoverPynectContributions,
  moduleDispatcherIncludes,
  projectPythonOptions,
  resolveExposedModule,
  syncProject,
} from './env/project-environment';
export { CURRENT_PYNECT_SCHEMA_VERSION, resolveProjectConfig } from './config/project';

export { PluginManager } from './plugins/plugin-manager';

export type {
  PynectConfig,
  ResolvedPynectConfig,
  IsolationConfig,
  DispatcherConfig,
  CallbackConfig,
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
  CanonicalPynectPackageManifest,
  PynectModuleManifest,
  PynectPackageManifest,
  PynectCallbackTable,
  PynectProjectTable,
  PynectToolTable,
  ProjectConfigOverrides,
  ResolvedProjectConfig,
} from './config/project';
export type {
  ExposedModule,
  PynectContribution,
  PynectProjectPlan,
  SyncProjectOptions,
  SyncProjectResult,
} from './env/project-environment';
