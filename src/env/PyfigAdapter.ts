import type {
  PyfigClient,
  PythonEmbeddingInfo,
  PythonEnvironment,
  PythonInfo,
} from 'pyfig';

/** Python selected by Pynect after its embedding requirements have been checked. */
export type SelectedPython = PythonInfo & { embedding: PythonEmbeddingInfo };

type PynectPythonEnvironment = Omit<PythonEnvironment, 'python'> & {
  python: SelectedPython;
};

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

export type PynectPyfigClient = PyfigClient;

interface AdapterModule {
  createPynectPyfig(options?: PynectPythonOptions): PynectPyfigClient;
  ensurePynectEnvironment(options?: PynectPythonOptions): Promise<{
    client: PynectPyfigClient;
    environment: PynectPythonEnvironment;
  }>;
  ensurePynectPython(options?: PynectPythonOptions): Promise<{
    client: PynectPyfigClient;
    python: SelectedPython;
  }>;
  projectRoot(explicit?: string): string;
}

// This CommonJS adapter is also used by install/build scripts before TypeScript is compiled.
const adapter = require('../../scripts/pyfig') as AdapterModule;

export const createPynectPyfig = adapter.createPynectPyfig;
export const ensurePynectEnvironment = adapter.ensurePynectEnvironment;
export const ensurePynectPython = adapter.ensurePynectPython;
export const pynectProjectRoot = adapter.projectRoot;
