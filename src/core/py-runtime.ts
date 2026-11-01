/**
 * pynect - PyRuntime
 * The central manager for the Python interpreter lifecycle.
 * Creates, configures, and shuts down the embedded CPython instance.
 */

import path from 'path';
import { resolveProjectConfig } from '../config/project';
import type { NativeAddon } from '../types/addon';
import { resolveConfig } from '../types/config';
import type { PynectConfig, ResolvedPynectConfig } from '../types/config';
import type { PyObjectId } from '../types/python';
import { PyProxy } from './py-proxy';
import { PyModule } from './py-module';
import { PyContext } from './py-context';
import { IsolatedWorker, type IsolatedCallOptions } from './isolated-worker';
import { PluginManager } from '../plugins/plugin-manager';
import { PackageInstaller } from '../env/package-installer';
import { ensurePynectPython } from '../env/pyfig-adapter';
import {
  createProjectPlan,
  moduleDispatcherIncludes,
  requiresProjectSync,
  syncProject,
  validateProjectEnvironment,
  type PynectEnvironmentState,
} from '../env/project-environment';
import { loadOrBuildNativeAddon } from '../native/native-addon-loader';
import { MemoryMonitor } from '../utils/memory-monitor';
import { Logger } from '../utils/logger';
import {
  translatePythonError,
  PynectShutdownError,
} from '../utils/error-translator';

const logger = new Logger('PyRuntime');

/**
 * PyRuntime - manages the lifecycle of the embedded Python interpreter.
 *
 * @example
 * ```typescript
 * const runtime = await PyRuntime.create({
 * project: { dependencies: ['pandas'] },
 * tool: { pynect: { autoSync: 'if-missing' } },
 * });
 *
 * const pd = await runtime.import('pandas');
 * const df = await pd.read_csv('data.csv');
 * const result = await df.to_dict('records');
 *
 * await runtime.shutdown();
 * ```
 */
export class PyRuntime {
  private readonly _config: ResolvedPynectConfig;
  private _pythonExecutable: string;
  private readonly _pythonLibrary: string;
  private readonly _pythonHome: string;
  private readonly _pythonPrefix: string;
  private readonly _pythonBaseExecutable: string;
  private readonly _addon: NativeAddon;
  private readonly _pluginManager: PluginManager;
  private readonly _memoryMonitor: MemoryMonitor;
  private _isolatedWorker?: IsolatedWorker;
  private _running = false;

  private constructor(
    config: ResolvedPynectConfig,
    addon: NativeAddon,
    pythonLibrary: string,
    pythonHome: string,
    pythonPrefix: string,
    pythonBaseExecutable: string,
  ) {
    this._config = config;
    this._pythonExecutable = config.pythonExecutable;
    this._pythonLibrary = pythonLibrary;
    this._pythonHome = pythonHome;
    this._pythonPrefix = pythonPrefix;
    this._pythonBaseExecutable = pythonBaseExecutable;
    this._addon = addon;
    this._pluginManager = new PluginManager();
    this._memoryMonitor = new MemoryMonitor({
      gcThreshold: this._parseBytes(config.gcThreshold),
    });
    this._memoryMonitor.attach(addon);
  }

  /**
   * Create and initialize a PyRuntime instance.
   */
  static async create(config: PynectConfig = {}): Promise<PyRuntime> {
    const projectOverrides = {
      ...config,
      projectRoot: config.projectRoot,
      python: config.python ?? config.pythonPath,
      requiresPython: config.requiresPython,
      managedPython: config.managedPython,
      uvVersion: config.uvVersion,
      installPython: config.installPython ?? config.autoInstallPython,
      installUv: config.installUv ?? config.autoInstallUv,
      createVirtualEnvironment:
        config.createVirtualEnvironment ?? config.autoCreateVirtualEnvironment,
      autoSync: config.autoSync,
      lockfile: config.lockfile,
      generatedDirectory: config.generatedDirectory,
      env: config.env,
    };
    const project = resolveProjectConfig(projectOverrides);
    const plan = createProjectPlan(projectOverrides);
    let environmentState: PynectEnvironmentState | undefined;
    if (requiresProjectSync(plan)) {
      if (project.autoSync === 'if-missing') {
        try {
          environmentState = validateProjectEnvironment(plan);
        } catch {
          environmentState = (await syncProject(projectOverrides)).state;
        }
      } else {
        environmentState = validateProjectEnvironment(plan);
      }
    }

    if (config.virtualenv?.autoInstall && (config.virtualenv.packages?.length ?? 0) > 0) {
      throw new Error(
        'virtualenv.autoInstall is no longer supported. Declare Python dependencies in the ' +
        'root package.json pynect.project.dependencies field and run "pynect sync".',
      );
    }

    // Resolve Python before loading the native addon. On Windows the addon
    // depends on the selected Python DLL, so its directory must already be on
    // PATH when Node loads the .node file.
    const { python: selected } = await ensurePynectPython({
      autoInstallPython: project.installPython,
      autoInstallUv: project.installUv,
      autoCreateVirtualEnvironment: project.createVirtualEnvironment,
      managedPython: project.managedPython,
      uvVersion: project.uvVersion,
      pythonRange: plan.pythonRange,
      pythonPath: project.python,
      projectRoot: project.projectRoot,
      env: project.env as Record<string, string>,
    });
    if (environmentState) {
      const selectedAbi = `${selected.implementation}-${selected.version}-` +
        `${selected.architecture}-${selected.pointerBits}`;
      if (!pathsEqual(environmentState.pythonExecutable, selected.executable) ||
        environmentState.pythonAbi !== selectedAbi) {
        throw new Error(
          'Pynect environment Python changed since the last sync. Run "pynect sync" before ' +
          'starting the application.',
        );
      }
    }
    const selectedProjectRoot = project.projectRoot;
    const selectedSitePackages = selected.virtualEnvironment
      ? [process.platform === 'win32'
        ? path.join(selected.prefix, 'Lib', 'site-packages')
        : path.join(
          selected.prefix,
          'lib',
          `python${selected.major}.${selected.minor}`,
          'site-packages',
        )]
      : [];
    if (config.virtualenv?.path) {
      const configuredVenv = path.resolve(config.virtualenv.path);
      if (!selected.virtualEnvironment || !pathsEqual(configuredVenv, selected.virtualEnvironment)) {
        throw new Error(
          `virtualenv.path must resolve to the Pyfig-selected environment at ${selected.virtualEnvironment}.`,
        );
      }
    }
    const preparedConfig: PynectConfig = {
      ...config,
      python: selected.executable,
      pythonPath_extra: [
        ...selectedSitePackages,
        ...(config.pythonPath_extra ?? []),
      ],
      requiresPython: plan.pythonRange,
      projectRoot: selectedProjectRoot,
      installPython: project.installPython,
      installUv: project.installUv,
      createVirtualEnvironment: project.createVirtualEnvironment,
      managedPython: project.managedPython,
      uvVersion: project.uvVersion,
      autoSync: project.autoSync,
      lockfile: project.lockfile,
      generatedDirectory: project.generatedDirectory,
      env: project.env as Record<string, string>,
      dispatcher: {
        ...config.dispatcher,
        include: [
          ...(config.dispatcher?.include ?? []),
          ...moduleDispatcherIncludes(plan),
        ],
      },
    };
    if (process.platform === 'win32') {
      const requiredDirectories = [
        selected.basePrefix,
        selected.embedding.libraryDirectory,
        path.dirname(selected.executable),
      ];
      const entries = (process.env['PATH'] ?? '').split(path.delimiter);
      for (const directory of requiredDirectories.reverse()) {
        if (!entries.some((entry) => entry.toLowerCase() === directory.toLowerCase())) {
          process.env['PATH'] = `${directory}${path.delimiter}${process.env['PATH'] ?? ''}`;
        }
      }
    }

    const resolved = resolveConfig(preparedConfig);

    // Set log level
    Logger.setGlobalLevel(resolved.logLevel);

    logger.info('Creating PyRuntime...');

    // Load the native addon
    let addon: NativeAddon;
    try {
      addon = loadOrBuildNativeAddon({
        projectRoot: selectedProjectRoot,
        pythonExecutable: selected.executable,
        pythonLibrary: selected.embedding.libraryPath,
        pythonVersion: selected.version,
      });
      logger.debug('Native addon loaded');
    } catch (err) {
      logger.error('Failed to load the Pynect native addon.', err);
      throw new Error(
        'Pynect native addon could not be loaded or built by the active JavaScript runtime.\n' +
        `Original error: ${(err as Error).message}`
      );
    }

    const runtime = new PyRuntime(
      resolved,
      addon,
      selected.embedding.libraryPath,
      selected.basePrefix,
      selected.prefix,
      selected.baseExecutable,
    );
    try {
      await runtime._initialize();
      return runtime;
    } catch (error) {
      if (addon.isInitialized()) {
        await addon.finalizePython().catch(() => undefined);
      }
      throw error;
    }
  }

  // Initialization

  private async _initialize(): Promise<void> {
    const startTime = performance.now();

    // 1. Detect/setup Python environment
    const pythonExecutable = await this._setupPythonEnvironment();
    this._pythonExecutable = pythonExecutable;

    if (this._config.isolation.enabled) {
      const packagedPython = path.join(__dirname, '..', '..', 'python');
      this._isolatedWorker = new IsolatedWorker({
        pythonExecutable,
        projectRoot: this._config.projectRoot,
        scriptPath: path.join(packagedPython, 'isolated_worker.py'),
        cwd: this._config.isolation.cwd,
        timeout: this._config.isolation.timeout,
        env: this._config.env,
        pythonPath: [packagedPython, ...this._config.pythonPathExtra],
        dispatcher: this._config.dispatcher,
        includeTracebacks: this._config.includeTracebacks,
      });
    }

    // 2. Initialize Python interpreter via C++ addon
    logger.debug(`Initializing Python interpreter: ${pythonExecutable}`);

    await this._addon.initializePython({
      pythonHome: this._pythonHome,
      pythonExecutable,
      pythonBaseExecutable: this._pythonBaseExecutable,
      pythonPrefix: this._pythonPrefix,
      pythonLibrary: this._pythonLibrary,
      threadPoolSize: this._config.threadPoolSize,
      maxQueueSize: this._config.maxQueueSize,
      gilReleaseInterval: this._config.gil.releaseInterval,
      callTimeout: this._config.callTimeout,
      pythonPathExtra: [
        path.join(__dirname, '..', '..', 'python'),
        ...this._config.pythonPathExtra,
      ],
      env: this._config.env,
      enableProfiling: this._config.profilingEnabled,
      includeTracebacks: this._config.includeTracebacks,
    });

    logger.debug('Python interpreter initialized');

    // 3. Bootstrap Python runtime helpers
    await this._bootstrapPythonRuntime();

    // 4. Register built-in plugins
    await this._pluginManager.registerBuiltins();

    // 5. Start memory monitoring
    this._memoryMonitor.startMonitoring(10000);

    this._running = true;

    const elapsed = (performance.now() - startTime).toFixed(0);
    logger.success(`PyRuntime ready in ${elapsed}ms (Python: ${pythonExecutable})`);
  }

  private async _setupPythonEnvironment(): Promise<string> {
    const pythonExecutable = this._config.pythonExecutable;
    logger.info(`Using repository virtualenv: ${path.dirname(path.dirname(pythonExecutable))}`);
    return pythonExecutable;
  }

  private async _bootstrapPythonRuntime(): Promise<void> {
    try {
      const dispatcherConfig = Buffer.from(
        JSON.stringify(this._config.dispatcher),
        'utf8',
      ).toString('base64');
      // Initialize pynect Python runtime helpers
      const bootstrapCode = `
# Initialize optional upstream helpers. The packaged Python directory is
# already inserted into sys.path by the native initialization options.
try:
    import pynect_runtime
    pynect_runtime.initialize()
except ImportError:
    pass  # Runtime helpers not available, basic operation only

import base64 as _pynect_base64
import json as _pynect_json
import pynect_dispatcher
pynect_dispatcher.configure(
    _pynect_json.loads(_pynect_base64.b64decode('${dispatcherConfig}'))
)
`;

      await this._addon.runPythonCode(bootstrapCode);
      logger.debug('Python runtime helpers bootstrapped');
    } catch (err) {
      logger.error('Failed to bootstrap the Python dispatcher', err);
      throw err;
    }
  }

  // Module Import

  /**
   * Import a Python module and return a PyProxy.
   *
   * @example
   * ```typescript
   * const pd = await runtime.import('pandas');
   * const df = await pd.read_csv('data.csv');
   * ```
   */
  async import(moduleName: string): Promise<PyModule> {
    this._ensureRunning();

    logger.debug(`Importing Python module: ${moduleName}`);

    const result = await this._addon.importModule(moduleName) as {
      success?: boolean;
      objectId?: number;
      isObject?: boolean;
      error?: { type: string; message: string; traceback: string };
    };

    if (!result.success) {
      if (result.error) {
        throw translatePythonError({
          type: result.error.type,
          message: result.error.message,
          traceback: result.error.traceback || '',
        });
      }
      throw new Error(`Failed to import Python module '${moduleName}'`);
    }

    if (!result.objectId) {
      throw new Error(`Module '${moduleName}' imported but no object ID returned`);
    }

    // Run plugin hooks
    await this._pluginManager.onModuleImported(moduleName, result.objectId as number);

    // Create PyModule
    const module = PyModule.fromRef(
      result.objectId as PyObjectId,
      moduleName,
      this._addon,
      this._config.callTimeout,
      this._config.executionTimeout,
    );

    logger.debug(`Module '${moduleName}' imported (id=${result.objectId})`);
    return module;
  }

  /**
   * Import multiple modules at once (concurrent).
   */
  async importAll(moduleNames: string[]): Promise<Record<string, PyModule>> {
    const modules = await Promise.all(
      moduleNames.map(async name => [name, await this.import(name)] as const)
    );
    return Object.fromEntries(modules);
  }

  /**
   * Call a JSON-compatible Python function in a killable child process.
   * This is a process boundary, not an operating-system sandbox.
   */
  async callIsolated<T = unknown>(
    moduleName: string,
    functionName: string,
    args: unknown[] = [],
    options: IsolatedCallOptions = {},
  ): Promise<T> {
    this._ensureRunning();
    if (!this._isolatedWorker) {
      throw new Error('Isolated calls are disabled; initialize with isolation.enabled: true.');
    }
    return this._isolatedWorker.call<T>(moduleName, functionName, args, options);
  }

  // Code Execution

  /**
   * Evaluate a Python expression.
   */
  async eval(expression: string): Promise<unknown> {
    this._ensureRunning();
    this._ensureUnsafeCodeAllowed('eval');

    const result = await this._addon.evalPython(expression) as {
      success?: boolean;
      resultJson?: string;
      objectId?: number;
      isObject?: boolean;
      error?: { type: string; message: string; traceback: string };
    };

    if (!result.success) {
      if (result.error) {
        throw translatePythonError({
          type: result.error.type,
          message: result.error.message,
          traceback: result.error.traceback || '',
        });
      }
      throw new Error('Python eval failed');
    }

    if (result.isObject && result.objectId) {
      return PyProxy._createFromObjectId(
        result.objectId as PyObjectId,
        [],
        this._addon,
        this._config.callTimeout,
        this._config.executionTimeout,
      );
    }

    if (result.resultJson !== undefined) {
      try {
        return JSON.parse(result.resultJson);
      } catch {
        return result.resultJson;
      }
    }

    return null;
  }

  /**
   * Execute Python statements.
   */
  async exec(code: string): Promise<void> {
    this._ensureRunning();
    this._ensureUnsafeCodeAllowed('exec');

    const result = await this._addon.runPythonCode(code) as {
      success?: boolean;
      error?: { type: string; message: string; traceback: string };
    };

    if (!result.success && result.error) {
      throw translatePythonError({
        type: result.error.type,
        message: result.error.message,
        traceback: result.error.traceback || '',
      });
    }
  }

  /**
   * Run a Python script file.
   */
  async runFile(filePath: string): Promise<unknown> {
    this._ensureRunning();
    this._ensureUnsafeCodeAllowed('runFile');

    const result = await this._addon.runPythonFile(filePath) as {
      success?: boolean;
      resultJson?: string;
      objectId?: number;
      isObject?: boolean;
      error?: { type: string; message: string; traceback: string };
    };

    if (!result.success) {
      if (result.error) {
        throw translatePythonError({
          type: result.error.type,
          message: result.error.message,
          traceback: result.error.traceback || '',
        });
      }
      throw new Error('Failed to run Python file');
    }

    return null;
  }

  // Context Management

  /**
   * Create an isolated Python execution context.
   */
  async createContext(): Promise<PyContext> {
    this._ensureRunning();
    this._ensureUnsafeCodeAllowed('createContext');
    return PyContext.create(this._addon);
  }

  // Package Management

  /**
   * Install Python packages into the active environment.
   */
  async installPackages(packages: string[]): Promise<void> {
    this._ensureRunning();
    if (!this._config.allowPackageInstall) {
      throw new Error('Runtime package installation is disabled; set allowPackageInstall: true.');
    }

    const installer = new PackageInstaller({
      pythonExecutable: this._pythonExecutable,
      cwd: this._config.projectRoot,
    });
    await installer.install(packages);

  }

  // Memory Management

  /**
   * Get current memory statistics.
   */
  getMemoryStats(): ReturnType<NativeAddon['getMemoryStats']> {
    this._ensureRunning();
    return this._addon.getMemoryStats();
  }

  /**
   * Trigger Python garbage collection.
   */
  async collectGarbage(): Promise<void> {
    this._ensureRunning();
    await this._addon.collectGarbage();
  }

  // Direct Addon Access

  /**
   * Get the underlying native addon.
   * Advanced use only.
   */
  getAddon(): NativeAddon {
    this._ensureUnsafeCodeAllowed('getAddon');
    return this._addon;
  }

  // State

  isRunning(): boolean {
    return this._running;
  }

  getConfig(): ResolvedPynectConfig {
    return { ...this._config };
  }

  // Shutdown

  /**
   * Gracefully shut down the Python runtime.
   * Releases all Python objects and finalizes the interpreter.
   */
  async shutdown(): Promise<void> {
    if (!this._running) {return;}

    logger.info('Shutting down PyRuntime...');
    // Stop memory monitoring
    this._memoryMonitor.stopMonitoring();

    await this._isolatedWorker?.close();
    this._isolatedWorker = undefined;

    // Finalize Python interpreter
    try {
      await this._addon.runPythonCode(
        'import pynect_dispatcher as _d; _d.shutdown()',
      );
      await this._addon.finalizePython();
      this._running = false;
      logger.success('PyRuntime shut down');
    } catch (err) {
      logger.error('Error during Python finalization', err);
      throw err;
    }
  }

  /**
   * Synchronous shutdown (for process.on('exit') handler).
   * Best-effort only - may not complete all cleanup.
   */
  shutdownSync(): void {
    if (!this._running) {return;}
    this._running = false;
    this._memoryMonitor.stopMonitoring();
    this._isolatedWorker?.closeSync();
    this._isolatedWorker = undefined;
    // Cannot await here - best effort
    logger.debug('Synchronous shutdown initiated');
  }

  // Private Helpers

  private _ensureRunning(): void {
    if (!this._running) {
      throw new PynectShutdownError(
        'PyRuntime has been shut down. Create a new runtime with PyRuntime.create().'
      );
    }
  }

  private _ensureUnsafeCodeAllowed(operation: string): void {
    if (!this._config.allowUnsafeCode) {
      throw new Error(
        `${operation} is disabled by default; set allowUnsafeCode: true for trusted local code.`,
      );
    }
  }

  private _parseBytes(str: string): number {
    const match = str.match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)?$/i);
    if (!match) {return 1_073_741_824;}
    const value = parseFloat(match[1]!);
    const unit = (match[2] ?? 'B').toUpperCase();
    const units: Record<string, number> = {
      B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4,
    };
    return Math.floor(value * (units[unit] ?? 1));
  }
}

function pathsEqual(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}
