import type { NativeAddon } from '../types/addon';
import type { PynectConfig, ResolvedPynectConfig } from '../types/config';
import type { PyProxyInterface } from '../types/python';
import type { PynectModules } from '../index';
import { resolveExposedModule } from '../env/project-environment';
import { withPynectLock } from '../utils/locking';
import type { IsolatedCallOptions } from './isolated-worker';
import type { PyContext } from './py-context';
import { PyRuntime } from './py-runtime';

/** The process-owned bridge to an application-scoped embedded Python environment. */
export interface PythonBridge extends AsyncDisposable {
  readonly isOpen: boolean;
  readonly config: ResolvedPynectConfig;

  import<Name extends keyof PynectModules & string>(moduleName: Name): Promise<PynectModules[Name]>;
  import(moduleName: string): Promise<PyProxyInterface>;
  importAll(moduleNames: string[]): Promise<Record<string, PyProxyInterface>>;
  callIsolated<Result = unknown>(
    moduleName: string,
    functionName: string,
    args?: unknown[],
    options?: IsolatedCallOptions,
  ): Promise<Result>;
  eval(expression: string): Promise<unknown>;
  exec(code: string): Promise<void>;
  runFile(filePath: string): Promise<unknown>;
  createContext(): Promise<PyContext>;
  getMemoryStats(): ReturnType<NativeAddon['getMemoryStats']>;
  collectGarbage(): Promise<void>;
  getAddon(): NativeAddon;
  close(): Promise<void>;
}

let activeBridge: EmbeddedPythonBridge | undefined;
let cleanupRegistered = false;

class EmbeddedPythonBridge implements PythonBridge {
  constructor(private readonly runtime: PyRuntime) {}

  get isOpen(): boolean {
    return this.runtime.isRunning();
  }

  get config(): ResolvedPynectConfig {
    return this.runtime.getConfig();
  }

  import<Name extends keyof PynectModules & string>(moduleName: Name): Promise<PynectModules[Name]>;
  import(moduleName: string): Promise<PyProxyInterface>;
  async import(moduleName: string): Promise<PyProxyInterface> {
    const exposed = moduleName.includes(':')
      ? resolveExposedModule(moduleName, this.config.projectRoot)
      : undefined;
    if (moduleName.includes(':') && !exposed) {
      throw new Error(`Unknown Pynect module id: ${moduleName}`);
    }
    return this.runtime.import(exposed?.import ?? moduleName);
  }

  async importAll(moduleNames: string[]): Promise<Record<string, PyProxyInterface>> {
    const modules = await Promise.all(
      moduleNames.map(async name => [name, await this.import(name)] as [string, PyProxyInterface]),
    );
    return Object.fromEntries(modules);
  }

  callIsolated<Result = unknown>(
    moduleName: string,
    functionName: string,
    args: unknown[] = [],
    options: IsolatedCallOptions = {},
  ): Promise<Result> {
    return this.runtime.callIsolated<Result>(moduleName, functionName, args, options);
  }

  eval(expression: string): Promise<unknown> {
    return this.runtime.eval(expression);
  }

  exec(code: string): Promise<void> {
    return this.runtime.exec(code);
  }

  runFile(filePath: string): Promise<unknown> {
    return this.runtime.runFile(filePath);
  }

  createContext(): Promise<PyContext> {
    return this.runtime.createContext();
  }

  getMemoryStats(): ReturnType<NativeAddon['getMemoryStats']> {
    return this.runtime.getMemoryStats();
  }

  collectGarbage(): Promise<void> {
    return this.runtime.collectGarbage();
  }

  getAddon(): NativeAddon {
    return this.runtime.getAddon();
  }

  async close(): Promise<void> {
    const locked = await withPynectLock(
      { operation: 'close-python-bridge' },
      async () => {
        if (!this.runtime.isRunning()) return;
        await this.runtime.close();
        if (activeBridge === this) activeBridge = undefined;
      },
      undefined,
      lifecycleLockOptions,
    );
    if (locked.context.state !== 'executed') {
      throw new Error(`Loqkit did not close the Python bridge: ${locked.context.state}.`);
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  closeSync(): void {
    this.runtime.closeSync();
    if (activeBridge === this) activeBridge = undefined;
  }
}

const lifecycleLockOptions = {
  key: 'pynect-python-bridge-lifecycle',
  name: 'Pynect Python bridge lifecycle',
  namespace: 'pynect',
  scope: { memory: true, worker: false, flock: false, poll: false },
} as const;

/** Create and prepare the process-owned embedded Python bridge. */
export async function createPythonBridge(config: PynectConfig = {}): Promise<PythonBridge> {
  const locked = await withPynectLock(
    { operation: 'create-python-bridge' },
    async () => {
      if (activeBridge?.isOpen) {
        throw new Error(
          'Only one embedded PythonBridge can be active in a process. ' +
          'Close the current bridge before creating another, or use process isolation.',
        );
      }
      const bridge = new EmbeddedPythonBridge(await PyRuntime.create(config));
      activeBridge = bridge;
      registerCleanup();
      return bridge;
    },
    undefined,
    lifecycleLockOptions,
  );
  if (locked.context.state !== 'executed' || !locked.value) {
    throw new Error(`Loqkit did not create the Python bridge: ${locked.context.state}.`);
  }
  return locked.value;
}

function registerCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;

  process.on('beforeExit', () => {
    const bridge = activeBridge;
    if (!bridge?.config.autoClose) return;
    void bridge.close().catch(() => undefined);
  });
  process.on('exit', () => {
    const bridge = activeBridge;
    if (!bridge?.config.autoClose || !bridge.isOpen) return;
    bridge.closeSync();
  });
}
