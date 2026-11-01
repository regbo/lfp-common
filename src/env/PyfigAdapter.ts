import type { ChildProcess, SpawnOptions, SpawnSyncOptions } from 'child_process';

export interface EmbeddingInfo {
  includeDirectory: string;
  headerPath: string;
  libraryPath: string;
  libraryDirectory: string;
  libraryName: string;
  libraryKind: 'import' | 'shared' | 'static';
}

export interface SelectedPython {
  executable: string;
  baseExecutable: string;
  version: string;
  major: number;
  minor: number;
  patch: number;
  releaseLevel: string;
  implementation: string;
  architecture: string;
  pointerBits: number;
  prefix: string;
  basePrefix: string;
  virtualEnvironment: string | null;
  gilDisabled: boolean;
  embedding: EmbeddingInfo;
}

export interface PynectPythonOptions {
  autoInstallPython?: boolean;
  autoInstallUv?: boolean;
  autoCreateVirtualEnvironment?: boolean;
  managedPython?: string;
  pythonPath?: string;
  pythonRange?: string;
  projectRoot?: string;
  uvVersion?: string;
  env?: Record<string, string>;
}

interface PyfigModule {
  ensureEnvironment(options: object): Promise<{
    python: SelectedPython;
    packageManager: unknown;
  }>;
  ensureVirtualEnvironment(options: object): Promise<SelectedPython>;
  pipSpawn(
    args: readonly string[],
    spawnOptions?: SpawnOptions,
    options?: object,
  ): Promise<ChildProcess>;
  pipSpawnSync(
    args: readonly string[],
    spawnOptions?: SpawnSyncOptions,
    options?: object,
  ): ReturnType<typeof import('child_process').spawnSync>;
  pythonSpawn(
    args: readonly string[],
    spawnOptions?: SpawnOptions,
    options?: object,
  ): Promise<ChildProcess>;
  pythonSpawnSync(
    args: readonly string[],
    spawnOptions?: SpawnSyncOptions,
    options?: object,
  ): ReturnType<typeof import('child_process').spawnSync>;
  uvSpawnSync(
    args: readonly string[],
    spawnOptions?: SpawnSyncOptions,
    options?: object,
  ): ReturnType<typeof import('child_process').spawnSync>;
}

interface AdapterModule {
  ensurePynectEnvironment(options?: PynectPythonOptions): Promise<{
    environment: { python: SelectedPython; packageManager: unknown };
    pyfigOptions: object;
  }>;
  ensurePynectPython(options?: PynectPythonOptions): Promise<{
    python: SelectedPython;
    pyfigOptions: object;
  }>;
  loadPyfig(): PyfigModule;
  projectRoot(explicit?: string): string;
  pynectPyfigOptions(options?: PynectPythonOptions): object;
}

// This CommonJS adapter is also used by install/build scripts before TypeScript is compiled.
const adapter = require('../../scripts/pyfig') as AdapterModule;

export const ensurePynectEnvironment = adapter.ensurePynectEnvironment;
export const ensurePynectPython = adapter.ensurePynectPython;
export const loadPyfig = adapter.loadPyfig;
export const pynectProjectRoot = adapter.projectRoot;
export const pynectPyfigOptions = adapter.pynectPyfigOptions;
