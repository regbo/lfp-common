import type { PythonInfo } from './PythonDetector';
import {
  ensurePynectPython,
  type PynectPythonOptions,
  type SelectedPython,
} from './PyfigAdapter';

export interface PythonProvisionerOptions {
  minVersion?: [number, number];
  managedPython?: string;
  uvVersion?: string;
  autoInstall?: boolean;
  pythonPath?: string;
  projectRoot?: string;
}

/** Compatibility wrapper around Pynect's centralized Pyfig environment selection. */
export class PythonProvisioner {
  constructor(private readonly options: PythonProvisionerOptions = {}) {}

  async ensurePython(): Promise<PythonInfo> {
    const [major, minor] = this.options.minVersion ?? [3, 10];
    const selection: PynectPythonOptions = {
      autoInstallPython: this.options.autoInstall,
      managedPython: this.options.managedPython,
      pythonPath: this.options.pythonPath,
      pythonRange: `>=${major}.${minor}.0 <4.0.0`,
      projectRoot: this.options.projectRoot,
      uvVersion: this.options.uvVersion,
    };
    const { python } = await ensurePynectPython(selection);
    if (python.major < major || (python.major === major && python.minor < minor)) {
      throw new Error(`Python ${python.version} does not satisfy >=${major}.${minor}.`);
    }
    return toLegacyPythonInfo(python);
  }
}

function toLegacyPythonInfo(python: SelectedPython): PythonInfo {
  return {
    executable: python.executable,
    version: python.version,
    major: python.major,
    minor: python.minor,
    patch: python.patch,
    prefix: python.prefix,
    isVirtualenv: python.virtualEnvironment !== null,
    platform: process.platform,
    arch: process.arch,
  };
}
