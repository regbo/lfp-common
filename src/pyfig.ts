import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import path from 'node:path';
import {
  filter,
  valid as validVersion,
  validRange,
} from '@renovatebot/pep440';
import { capture, findExecutable } from './process.js';
import { resolveUv } from './uv.js';

const DEFAULT_UV = '>=0.10,<1';

const PYTHON_PROBE = String.raw`
import json
import os
import platform
import struct
import sys
import sysconfig

base_prefix = getattr(sys, "base_prefix", sys.prefix)
include_directory = sysconfig.get_path("include") or ""
header_path = os.path.join(include_directory, "Python.h") if include_directory else ""
library_candidates = []
if os.name == "nt":
    library_directory = sysconfig.get_config_var("LIBDIR") or os.path.join(base_prefix, "libs")
    configured_library = sysconfig.get_config_var("LDLIBRARY") or ""
    if configured_library:
        library_candidates.append(os.path.join(library_directory, os.path.splitext(configured_library)[0] + ".lib"))
    library_candidates.append(os.path.join(library_directory, f"python{sys.version_info.major}{sys.version_info.minor}.lib"))
else:
    for directory in [
        sysconfig.get_config_var("LIBDIR"),
        sysconfig.get_config_var("LIBPL"),
        os.path.join(base_prefix, "lib"),
    ]:
        for name in [sysconfig.get_config_var("LDLIBRARY"), sysconfig.get_config_var("LIBRARY")]:
            if directory and name:
                library_candidates.append(os.path.join(directory, name))

release_suffix = {"alpha": "a", "beta": "b", "candidate": "rc", "final": ""}[sys.version_info.releaselevel]
if release_suffix:
    release_suffix += str(sys.version_info.serial)

print(json.dumps({
    "executable": sys.executable,
    "version": ".".join(map(str, sys.version_info[:3])) + release_suffix,
    "implementation": sys.implementation.name,
    "architecture": platform.machine().lower(),
    "pointerBits": struct.calcsize("P") * 8,
    "gilDisabled": bool(sysconfig.get_config_var("Py_GIL_DISABLED")),
    "embedding": os.path.isfile(header_path) and any(os.path.isfile(path) for path in library_candidates),
}))
`;

export interface PyfigOptions {
  /** uv executable or PEP 440 constraint. Executables take precedence. */
  uv?: string;
  /** Python executable or PEP 440 constraint. Executables take precedence. */
  python?: string;
  /** Require CPython headers, a linkable library, and matching runtime architecture. */
  requireEmbedding?: boolean;
  /** Reject free-threaded Python builds. */
  requireGil?: boolean;
  /** Directory used for uv project and configuration discovery. */
  cwd?: string;
  /** Environment used to locate executables and invoke child processes. */
  env?: Readonly<Record<string, string | undefined>>;
}

export class PythonContext {
  readonly #cwd: string;
  readonly #env: NodeJS.ProcessEnv;
  /** Absolute path to the resolved uv executable. */
  readonly uv: string;
  /** Absolute path to the resolved Python interpreter. */
  readonly python: string;

  constructor(
    uvPath: string,
    pythonPath: string,
    cwd = process.cwd(),
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.#cwd = cwd;
    this.#env = { ...env };
    this.uv = uvPath;
    this.python = pythonPath;
    Object.freeze(this);
  }

  /** Spawn `uv run` with the resolved Python pinned before the command separator. */
  run(...args: string[]): ChildProcess;
  run(...args: [...command: string[], options: SpawnOptions]): ChildProcess;
  run(...input: Array<string | SpawnOptions>): ChildProcess {
    const { args, spawnOptions } = splitRunInput(input);
    return spawn(this.uv, buildRunArgs(this.python, args), {
      cwd: this.#cwd,
      env: this.#env,
      stdio: 'inherit',
      windowsHide: true,
      ...spawnOptions,
    });
  }
}

/** Resolve compatible uv and Python executables without owning either environment. */
export async function pyfig(options: PyfigOptions = {}): Promise<PythonContext> {
  const {
    uv: uvRequest = DEFAULT_UV,
    python: pythonRequest,
    requireEmbedding = false,
    requireGil = false,
    cwd = process.cwd(),
    env: suppliedEnvironment,
  } = options;
  const env = mergeEnvironment(suppliedEnvironment);
  const workingDirectory = path.resolve(cwd);
  const uvPath = await selectUv(uvRequest, workingDirectory, env);
  const selectedPythonPath = await selectPython({
    cwd: workingDirectory,
    env,
    pythonRequest,
    requireEmbedding,
    requireGil,
    uvPath,
  });

  return new PythonContext(uvPath, selectedPythonPath, workingDirectory, env);
}

/** @internal Build a safe `uv run` argv array from the public variadic input. */
export function buildRunArgs(pythonPath: string, args: readonly string[]): string[] {
  const separator = args.indexOf('--');
  if (separator < 0) {
    return ['run', '--python', pythonPath, '--', ...args];
  }

  const uvArgs = args.slice(0, separator);
  const command = args.slice(separator + 1);
  if (uvArgs.some(argument => argument === '--python' || argument.startsWith('--python='))) {
    throw new TypeError('run() does not accept --python before --; Python is selected by pyfig().');
  }
  uvArgs.push('--python', pythonPath);
  return ['run', ...uvArgs, '--', ...command];
}

function splitRunInput(input: Array<string | SpawnOptions>): {
  args: string[];
  spawnOptions: SpawnOptions;
} {
  const values = [...input];
  const last = values.at(-1);
  const spawnOptions = typeof last === 'object' && last !== null && !Array.isArray(last)
    ? values.pop() as SpawnOptions
    : {};
  if (!values.every((value): value is string => typeof value === 'string')) {
    throw new TypeError('uv run arguments must be strings with an optional SpawnOptions object last.');
  }
  return { args: values, spawnOptions };
}

interface Selection {
  executable: string | null;
  specifier: string | null;
}

interface PythonProbe {
  architecture: string;
  embedding: boolean;
  executable: string;
  gilDisabled: boolean;
  implementation: string;
  pointerBits: number;
  version: string;
}

interface PythonSelectionOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  pythonRequest: string | undefined;
  requireEmbedding: boolean;
  requireGil: boolean;
  uvPath: string;
}

async function selectUv(
  request: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const selection = await executableOrSpecifier('uv', request, cwd, env);
  if (selection.executable) return selection.executable;
  const specifier = selection.specifier;
  if (!specifier) throw new Error('uv selection did not contain a version specifier.');
  return resolveUv(specifier, cwd, env);
}

async function selectPython(options: PythonSelectionOptions): Promise<string> {
  if (options.pythonRequest !== undefined) {
    const selection = await executableOrSpecifier(
      'python',
      options.pythonRequest,
      options.cwd,
      options.env,
    );
    if (selection.executable) {
      const explicit = await probePython(selection.executable, options.cwd, options.env);
      validatePythonCapabilities(explicit, options);
      return explicit.executable;
    }
    if (!selection.specifier) throw new Error('Python selection did not contain a version specifier.');
    return selectDiscoveredPython(selection.specifier, options);
  }
  return selectDiscoveredPython(null, options);
}

async function selectDiscoveredPython(
  specifier: string | null,
  options: PythonSelectionOptions,
): Promise<string> {
  const request = specifier ? [specifier] : [];
  let systemFailure: unknown;
  try {
    // `--system` excludes virtual environments; `--no-managed-python` also
    // excludes uv's cache so this pass genuinely prefers host installations.
    const systemPath = await findPython(
      options.uvPath,
      ['--system', '--no-managed-python', ...request],
      options,
    );
    const system = await probePython(systemPath, options.cwd, options.env);
    validatePythonVersion(system, specifier);
    validatePythonCapabilities(system, options);
    return system.executable;
  } catch (error) {
    systemFailure = error;
  }

  try {
    const managedPath = await findPython(options.uvPath, ['--managed-python', ...request], options);
    const managed = await probePython(managedPath, options.cwd, options.env);
    validatePythonVersion(managed, specifier);
    validatePythonCapabilities(managed, options);
    return managed.executable;
  } catch (error) {
    throw new Error(
      `No compatible Python was found. System: ${errorMessage(systemFailure)} Managed: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

async function findPython(
  uvPath: string,
  args: readonly string[],
  options: Pick<PythonSelectionOptions, 'cwd' | 'env'>,
): Promise<string> {
  const output = await capture(uvPath, ['python', 'find', ...args], options.cwd, options.env);
  const executable = output.trim().split(/\r?\n/u).at(-1) ?? '';
  if (!path.isAbsolute(executable)) {
    throw new Error(`uv did not report an absolute Python path: ${executable || '<empty>'}`);
  }
  return path.normalize(executable);
}

async function probePython(
  executable: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<PythonProbe> {
  const output = await capture(executable, ['-I', '-S', '-c', PYTHON_PROBE], cwd, env);
  const line = output.trim().split(/\r?\n/u).at(-1) ?? '';
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new Error(`${JSON.stringify(executable)} did not return valid Python metadata.`, {
      cause: error,
    });
  }
  if (!isPythonProbe(value)) {
    throw new Error(`${JSON.stringify(executable)} returned incomplete Python metadata.`);
  }
  if (!path.isAbsolute(value.executable)) {
    throw new Error(`${JSON.stringify(executable)} reported a non-absolute executable path.`);
  }
  return { ...value, executable: path.normalize(value.executable) };
}

function validatePythonVersion(python: PythonProbe, specifier: string | null): void {
  if (!specifier) return;
  const version = validVersion(python.version);
  if (!version) throw new Error(`Python ${python.executable} reported invalid version ${python.version}.`);
  if (filter([version], specifier).length !== 1) {
    throw new Error(`Python ${version} does not satisfy ${specifier}.`);
  }
}

function validatePythonCapabilities(
  python: PythonProbe,
  options: Pick<PythonSelectionOptions, 'requireEmbedding' | 'requireGil'>,
): void {
  if (options.requireEmbedding) {
    if (python.implementation !== 'cpython') {
      throw new Error(`Python embedding requires CPython, received ${python.implementation}.`);
    }
    if (!python.embedding) {
      throw new Error(`Python ${python.executable} does not provide embedding headers and a library.`);
    }
    if (!pythonArchitectureMatchesRuntime(python)) {
      throw new Error(`Python ${python.executable} does not match the JavaScript runtime architecture.`);
    }
  }
  if (options.requireGil && python.gilDisabled) {
    throw new Error(`Python ${python.executable} is free-threaded but requireGil is enabled.`);
  }
}

function pythonArchitectureMatchesRuntime(python: PythonProbe): boolean {
  if (python.pointerBits !== (process.arch === 'ia32' ? 32 : 64)) return false;
  if (process.arch === 'x64') return python.architecture === 'x86_64' || python.architecture === 'amd64';
  if (process.arch === 'arm64') return python.architecture === 'aarch64' || python.architecture === 'arm64';
  if (process.arch === 'ia32') {
    return python.architecture === 'x86' || python.architecture === 'i386' ||
      python.architecture === 'i686';
  }
  return python.architecture === process.arch;
}

async function executableOrSpecifier(
  name: 'python' | 'uv',
  value: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<Selection> {
  assertNonempty(name, value);
  const executable = await findExecutable(value, cwd, env);
  if (executable) return { executable, specifier: null };
  if (validRange(value)) return { executable: null, specifier: value };
  throw new TypeError(
    `${name} must resolve to an executable or be a valid PEP 440 specifier, received ${JSON.stringify(value)}.`,
  );
}

function isPythonProbe(value: unknown): value is PythonProbe {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const probe = value as Record<string, unknown>;
  return typeof probe['architecture'] === 'string' &&
    typeof probe['embedding'] === 'boolean' &&
    typeof probe['executable'] === 'string' &&
    typeof probe['gilDisabled'] === 'boolean' &&
    typeof probe['implementation'] === 'string' &&
    typeof probe['pointerBits'] === 'number' &&
    typeof probe['version'] === 'string';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Apply caller overrides without leaving case-variant duplicate keys on Windows. */
function mergeEnvironment(
  supplied: Readonly<Record<string, string | undefined>> | undefined,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(supplied ?? {})) {
    if (process.platform === 'win32') {
      const existing = Object.keys(environment).find(candidate =>
        candidate.toLowerCase() === key.toLowerCase()
      );
      if (existing && existing !== key) delete environment[existing];
    }
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }
  return environment;
}

function assertNonempty(name: string, value: string): void {
  if (value.trim() === '') throw new TypeError(`${name} must not be empty.`);
}
