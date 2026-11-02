import type {
  Python as PyfigPython,
  PythonEmbeddingInfo,
  PythonEnvironment,
  PythonInfo,
  PyfigOptions,
} from 'pyfig';

export type SelectedPython = PythonInfo & { embedding: PythonEmbeddingInfo };

export type SelectedPythonEnvironment = Omit<PythonEnvironment, 'python'> & {
  python: SelectedPython;
};

export type PynectPythonOptions = PyfigOptions;
export type PynectPython = PyfigPython;

interface PythonModule {
  createPython(options?: PynectPythonOptions): PynectPython;
  preparePython(options?: PynectPythonOptions): Promise<{
    runtime: PynectPython;
    environment: SelectedPythonEnvironment;
  }>;
  projectRoot(explicit?: string): string;
}

// Build scripts and compiled source share this policy so native and runtime ABI selection agree.
const python = require('../../scripts/python') as PythonModule;

export const createPython = python.createPython;
export const preparePython = python.preparePython;
export const pynectProjectRoot = python.projectRoot;
