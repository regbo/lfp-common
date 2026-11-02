import path from 'node:path';
import {
  filter,
  valid as validVersion,
  validRange,
} from '@renovatebot/pep440';
import { z } from 'zod';
import { capture, findExecutable, findExecutables } from './process.js';
import { resolveUv } from './uv.js';
import { debugLog, setDebugLogging } from './logging.js';

export const DEFAULT_UV = '>=0.10,<1';

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

export const pyfigOptionsSchema = z.object({
  uv: z.string()
    .trim()
    .min(1, 'uv must not be empty.')
    .default(DEFAULT_UV)
    .describe('uv executable or PEP 440 constraint. Executables take precedence.'),
  python: z.string()
    .trim()
    .min(1, 'python must not be empty.')
    .optional()
    .describe('Python executable or PEP 440 constraint. Executables take precedence.'),
  requireEmbedding: z.boolean()
    .default(false)
    .describe('Require CPython headers, a linkable library, and matching runtime architecture.'),
  requireGil: z.boolean()
    .default(false)
    .describe('Reject free-threaded Python builds.'),
  debug: z.boolean()
    .default(false)
    .describe('Write resolution, download, and provisioning diagnostics to stderr.'),
  cwd: z.string()
    .trim()
    .min(1, 'cwd must not be empty.')
    .default(() => process.cwd())
    .describe('Directory used for uv project and configuration discovery.'),
  env: z.union([
    z.record(z.string(), z.string().optional()),
    z.string().transform(value => {
      const parsed: unknown = JSON.parse(value);
      return z.record(z.string(), z.string().optional()).parse(parsed);
    }),
  ])
    .optional()
    .describe('Environment overrides used during executable resolution and provisioning.'),
}).readonly().describe('Options for resolving a compatible uv and Python runtime context.');

export type PyfigOptions = z.input<typeof pyfigOptionsSchema>;

export interface ExecutableMetadata {
  /** Absolute path to the executable. */
  readonly path: string;
  /** How the executable was selected or obtained. */
  readonly source: 'cache' | 'download' | 'explicit' | 'managed' | 'path' | 'system';
  /** PEP 440-compatible executable version. */
  readonly version: string;
}

export class PythonContext {
  /** Resolved uv executable metadata. */
  readonly uv: ExecutableMetadata;
  /** Resolved Python interpreter metadata. */
  readonly python: ExecutableMetadata;

  constructor(uv: ExecutableMetadata, python: ExecutableMetadata) {
    this.uv = Object.freeze({ ...uv });
    this.python = Object.freeze({ ...python });
    Object.freeze(this);
  }
}

/** Resolve or provision a compatible uv and Python context. */
export async function pyfig(options: PyfigOptions = {}): Promise<PythonContext> {
  const parsedOptions = pyfigOptionsSchema.parse(options);
  setDebugLogging(parsedOptions.debug);
  const {
    uv: uvRequest,
    python: pythonRequest,
    requireEmbedding,
    requireGil,
    cwd,
    env: suppliedEnvironment,
  } = parsedOptions;
  const env = mergeEnvironment(suppliedEnvironment);
  const workingDirectory = path.resolve(cwd);
  debugLog('Resolving runtime context.', {
    cwd: workingDirectory,
    python: pythonRequest ?? 'auto',
    uv: uvRequest,
  });
  const uv = await selectUv(uvRequest, workingDirectory, env);
  debugLog('Resolved uv.', uv);
  const python = await selectPython({
    cwd: workingDirectory,
    env,
    pythonRequest,
    requireEmbedding,
    requireGil,
    uvPath: uv.path,
  });
  debugLog('Resolved Python.', {
    path: python.executable,
    source: python.source,
    version: python.version,
  });

  return new PythonContext(uv, {
    path: python.executable,
    source: python.source,
    version: python.version,
  });
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

type PythonSource = Extract<ExecutableMetadata['source'], 'explicit' | 'managed' | 'path' | 'system'>;
type PythonResolution = PythonProbe & { source: PythonSource };

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
): Promise<ExecutableMetadata> {
  const selection = await executableOrSpecifier('uv', request, cwd, env);
  if (selection.executable) {
    debugLog('Using requested uv executable.', { path: selection.executable });
    return { ...await probeUv(selection.executable, cwd, env), source: 'explicit' };
  }
  const specifier = selection.specifier;
  if (!specifier) throw new Error('uv selection did not contain a version specifier.');
  debugLog('Resolving uv version constraint.', { specifier });
  const resolved = await resolveUv(specifier, cwd, env);
  return { ...await probeUv(resolved.path, cwd, env), source: resolved.source };
}

async function selectPython(options: PythonSelectionOptions): Promise<PythonResolution> {
  if (options.pythonRequest !== undefined) {
    const selection = await executableOrSpecifier(
      'python',
      options.pythonRequest,
      options.cwd,
      options.env,
    );
    if (selection.executable) {
      debugLog('Using requested Python executable.', { path: selection.executable });
      const explicit = await probePython(selection.executable, options.cwd, options.env);
      validatePythonCapabilities(explicit, options);
      return { ...explicit, source: 'explicit' };
    }
    if (!selection.specifier) throw new Error('Python selection did not contain a version specifier.');
    return selectDiscoveredPython(selection.specifier, options);
  }
  return selectDiscoveredPython(null, options);
}

async function selectDiscoveredPython(
  specifier: string | null,
  options: PythonSelectionOptions,
): Promise<PythonResolution> {
  const request = specifier ? [specifier] : [];
  let systemFailure: unknown;
  try {
    debugLog('Searching PATH for a compatible system Python.', { specifier: specifier ?? 'any' });
    const direct = await findPathPython(specifier, options);
    if (direct.python) return { ...direct.python, source: 'path' };

    debugLog('No compatible PATH Python found; falling back to uv system discovery.', {
      specifier: specifier ?? 'any',
    });
    // `--system` excludes virtual environments; `--no-managed-python` also
    // excludes uv's cache so this pass genuinely prefers host installations.
    const systemPath = await findPython(
      options.uvPath,
      ['--system', '--no-managed-python', ...request],
      {
        ...options,
        env: withoutPathDirectories(options.env, direct.brokenDirectories),
      },
    );
    const system = await probePython(systemPath, options.cwd, options.env);
    validatePythonVersion(system, specifier);
    validatePythonCapabilities(system, options);
    return { ...system, source: 'system' };
  } catch (error) {
    systemFailure = error;
    debugLog('System Python search failed.', { error: errorMessage(error) });
  }

  try {
    debugLog('Searching for a compatible uv-managed Python.', { specifier: specifier ?? 'any' });
    const managedPath = await findPython(options.uvPath, ['--managed-python', ...request], options);
    const managed = await probePython(managedPath, options.cwd, options.env);
    validatePythonVersion(managed, specifier);
    validatePythonCapabilities(managed, options);
    return { ...managed, source: 'managed' };
  } catch (error) {
    throw new Error(
      `No compatible Python was found. System: ${errorMessage(systemFailure)} Managed: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

async function findPathPython(
  specifier: string | null,
  options: PythonSelectionOptions,
): Promise<{ brokenDirectories: Set<string>; python: PythonProbe | null }> {
  const candidates = await findExecutables(pythonExecutableNames(specifier), options.env);
  const results = await Promise.all(candidates.map(async candidate => {
    if (isWindowsPythonAlias(candidate, options.env)) {
      debugLog('Skipping Windows Python app execution alias.', { path: candidate });
      return { broken: true, candidate, python: null };
    }
    try {
      const python = await probePython(candidate, options.cwd, options.env);
      validatePythonVersion(python, specifier);
      validatePythonCapabilities(python, options);
      return { broken: false, candidate, python };
    } catch (error) {
      debugLog('Skipping incompatible PATH Python candidate.', {
        error: errorMessage(error),
        path: candidate,
      });
      return {
        broken: isWindowsAliasFailure(error),
        candidate,
        python: null,
      };
    }
  }));
  const match = results.find(result => result.python !== null)?.python ?? null;
  if (match) {
    debugLog('Using compatible Python from PATH.', {
      path: match.executable,
      version: match.version,
    });
  }
  return {
    brokenDirectories: new Set(results.filter(result => result.broken).map(result =>
      path.dirname(result.candidate)
    )),
    python: match,
  };
}

function pythonExecutableNames(specifier: string | null): string[] {
  const names = ['python', 'python3'];
  if (!specifier) return names;
  const versions = specifier.match(/\d+(?:\.\d+)?/gu) ?? [];
  for (const version of versions) {
    if (version.includes('.')) names.push(`python${version}`);
  }
  return [...new Set(names)];
}

async function probeUv(
  executable: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<Omit<ExecutableMetadata, 'source'>> {
  const output = await capture(executable, ['--version'], cwd, env);
  const version = validVersion(output.trim().match(/^uv\s+(\S+)/iu)?.[1] ?? '');
  if (!version) {
    throw new Error(`${JSON.stringify(executable)} did not report a valid uv version.`);
  }
  return { path: path.normalize(executable), version };
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
  if (isWindowsPythonAlias(executable, env)) {
    debugLog('Skipping Windows Python app execution alias.', { path: executable });
    throw new Error(`${JSON.stringify(executable)} is a Windows Python app execution alias.`);
  }
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

function isWindowsPythonAlias(executable: string, env: NodeJS.ProcessEnv): boolean {
  if (process.platform !== 'win32') return false;
  const localAppData = Object.entries(env).find(([key]) =>
    key.toLowerCase() === 'localappdata'
  )?.[1];
  if (!localAppData) return false;
  const aliases = path.resolve(localAppData, 'Microsoft', 'WindowsApps');
  const candidate = path.resolve(executable);
  const relative = path.relative(aliases, candidate);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative) &&
    /^python(?:3(?:\.\d+)?)?\.exe$/iu.test(path.basename(candidate));
}

function isWindowsAliasFailure(error: unknown): boolean {
  return process.platform === 'win32' &&
    errorMessage(error).includes('Python was not found; run without arguments to install from the Microsoft Store');
}

function withoutPathDirectories(
  env: NodeJS.ProcessEnv,
  excluded: ReadonlySet<string>,
): NodeJS.ProcessEnv {
  if (excluded.size === 0) return env;
  const normalized = new Set([...excluded].map(directory => path.resolve(directory).toLowerCase()));
  const filtered = (Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '')
    .split(path.delimiter)
    .filter(directory => !normalized.has(path.resolve(directory).toLowerCase()))
    .join(path.delimiter);
  debugLog('Removed broken Python alias directories from fallback PATH.', {
    directories: [...excluded],
  });
  return { ...env, PATH: filtered };
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
