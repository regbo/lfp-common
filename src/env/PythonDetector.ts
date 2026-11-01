/**
 * Compatibility facade for callers that previously enumerated host Python
 * installations. Pynect now exposes only its Pyfig-selected repository venv.
 */

import path from 'path';
import { Logger } from '../utils/Logger';
import {
  ensurePynectPython,
  loadPyfig,
  pynectPyfigOptions,
  type PynectPythonOptions,
  type SelectedPython,
} from './PyfigAdapter';
import { isPythonModuleName } from './executables';

const logger = new Logger('PythonDetector');

export interface PythonInfo {
  executable: string;
  version: string;
  major: number;
  minor: number;
  patch: number;
  prefix: string;
  isVirtualenv: boolean;
  isConda: boolean;
  condaEnv?: string;
  platform: string;
  arch: string;
}

export interface DetectorOptions {
  /** Minimum Python version required. Default: [3, 10]. */
  minVersion?: [number, number];
  /** Base interpreter to check before Pyfig's managed fallback. */
  pythonPath?: string;
  /** Timeout for synchronous compatibility probes. Default: 10000. */
  timeout?: number;
  /** Require an already prepared explicit root environment without fallback. */
  explicitOnly?: boolean;
  /** Modules that must be importable from the repository venv. */
  requiredModules?: string[];
  /** Repository root that owns `.venv`. Defaults to Pyfig discovery. */
  projectRoot?: string;
}

const PROBE_SCRIPT = `
import json, platform, sys
print(json.dumps({
    "executable": sys.executable,
    "base_executable": getattr(sys, "_base_executable", sys.executable),
    "version": ".".join(map(str, sys.version_info[:3])),
    "major": sys.version_info.major,
    "minor": sys.version_info.minor,
    "patch": sys.version_info.micro,
    "prefix": sys.prefix,
    "is_venv": sys.prefix != getattr(sys, "base_prefix", sys.prefix),
    "platform": sys.platform,
    "arch": platform.machine(),
}))
`.trim();

export class PythonDetector {
  private readonly options: Required<Omit<DetectorOptions, 'projectRoot'>> & {
    projectRoot?: string;
  };

  constructor(options: DetectorOptions = {}) {
    this.options = {
      minVersion: options.minVersion ?? [3, 10],
      pythonPath: options.pythonPath ?? '',
      timeout: options.timeout ?? 10_000,
      explicitOnly: options.explicitOnly ?? false,
      requiredModules: options.requiredModules ?? [],
      projectRoot: options.projectRoot,
    };
  }

  async detect(): Promise<PythonInfo> {
    try {
      const { python } = await ensurePynectPython(this.selectionOptions());
      const info = toPythonInfo(python);
      if (!this.isCompatible(info)) {
        throw new PythonVersionError(info.version, this.options.minVersion.join('.'));
      }
      const missing = this.checkModules(info.executable, this.options.requiredModules);
      if (missing.length > 0) {
        throw new PythonNotFoundError(
          `Repository Python ${info.executable} is missing modules: ${missing.join(', ')}.`,
        );
      }
      logger.info(`PythonDetector: using repository venv ${info.executable} (${info.version})`);
      return info;
    } catch (error) {
      if (error instanceof PythonNotFoundError || error instanceof PythonVersionError) throw error;
      throw new PythonNotFoundError(
        `Could not prepare repository Python >= ${this.options.minVersion.join('.')}: ` +
        `${errorMessage(error)}`,
      );
    }
  }

  /** Probe through Pyfig; never executes the supplied interpreter directly. */
  probe(executablePath: string): PythonInfo | null {
    if (!executablePath) return null;
    const pyfig = loadPyfig();
    const result = pyfig.pythonSpawnSync(
      ['-c', PROBE_SCRIPT],
      {
        encoding: 'utf8',
        timeout: this.options.timeout,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      },
      pynectPyfigOptions(this.selectionOptions(executablePath)),
    );
    const stdout = outputText(result.stdout);
    if (result.status !== 0 || result.error || !stdout.trim()) return null;
    try {
      const raw = JSON.parse(stdout.trim()) as ProbeResult;
      if (path.isAbsolute(executablePath)) {
        const requested = normalizePath(executablePath);
        if (
          requested !== normalizePath(raw.executable) &&
          requested !== normalizePath(raw.base_executable)
        ) return null;
      }
      return probeToPythonInfo(raw);
    } catch {
      return null;
    }
  }

  isCompatible(info: PythonInfo): boolean {
    const [major, minor] = this.options.minVersion;
    return info.major > major || (info.major === major && info.minor >= minor);
  }

  checkModules(executable: string, modules: string[]): string[] {
    if (modules.length === 0) return [];
    const invalid = modules.filter(module => !isPythonModuleName(module));
    if (invalid.length > 0) {
      throw new TypeError(`Invalid Python module name: ${invalid.join(', ')}`);
    }
    const script = modules
      .map(module => `try:\n    import ${module}\nexcept ImportError:\n    print("MISSING:${module}")`)
      .join('\n');
    const result = loadPyfig().pythonSpawnSync(
      ['-c', script],
      { encoding: 'utf8', timeout: this.options.timeout, maxBuffer: 1024 * 256 },
      pynectPyfigOptions(this.selectionOptions(executable)),
    );
    if (result.status !== 0 || result.error) return [...modules];
    return outputText(result.stdout)
      .split(/\r?\n/u)
      .map(line => line.match(/^MISSING:(.+)$/u)?.[1])
      .filter((module): module is string => Boolean(module));
  }

  /** The fixed-root policy intentionally exposes one selected interpreter. */
  async listAll(): Promise<PythonInfo[]> {
    return [await this.detect()];
  }

  private selectionOptions(pythonPath = this.options.pythonPath): PynectPythonOptions {
    const [major, minor] = this.options.minVersion;
    return {
      pythonPath,
      pythonRange: `>=${major}.${minor}.0 <4.0.0`,
      projectRoot: this.options.projectRoot,
      autoInstallPython: !this.options.explicitOnly,
      autoInstallUv: !this.options.explicitOnly,
      autoCreateVirtualEnvironment: !this.options.explicitOnly,
    };
  }
}

interface ProbeResult {
  executable: string;
  base_executable: string;
  version: string;
  major: number;
  minor: number;
  patch: number;
  prefix: string;
  is_venv: boolean;
  platform: string;
  arch: string;
}

function probeToPythonInfo(raw: ProbeResult): PythonInfo {
  return {
    executable: raw.executable,
    version: raw.version,
    major: raw.major,
    minor: raw.minor,
    patch: raw.patch,
    prefix: raw.prefix,
    isVirtualenv: raw.is_venv,
    isConda: false,
    platform: raw.platform,
    arch: raw.arch,
  };
}

function toPythonInfo(python: SelectedPython): PythonInfo {
  return {
    executable: python.executable,
    version: python.version,
    major: python.major,
    minor: python.minor,
    patch: python.patch,
    prefix: python.prefix,
    isVirtualenv: python.virtualEnvironment !== null,
    isConda: false,
    platform: process.platform,
    arch: process.arch,
  };
}

function normalizePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function outputText(value: string | Buffer | null): string {
  return typeof value === 'string' ? value : value?.toString('utf8') ?? '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class PythonNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PythonNotFoundError';
  }
}

export class PythonVersionError extends Error {
  constructor(found: string, required: string) {
    super(`Python ${found} is below the minimum required version ${required}.`);
    this.name = 'PythonVersionError';
  }
}
