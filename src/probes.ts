import path from 'node:path';
import semver from 'semver';
import type { ResolvedPyfigOptions } from './config.js';
import { resolveExecutable, run, type CommandSpec } from './process.js';
import { activateVirtualEnvironment } from './virtual-environment.js';

export interface PythonInfo {
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
  embedding: PythonEmbeddingInfo | null;
}

export interface PythonEmbeddingInfo {
  includeDirectory: string;
  headerPath: string;
  libraryPath: string;
  libraryDirectory: string;
  libraryName: string;
  libraryKind: 'import' | 'shared' | 'static';
}

export interface PackageManagerInfo {
  kind: 'pip' | 'uv';
  executable: string;
  prefixArgs: string[];
  version: string;
  pythonExecutable: string;
  virtualEnvironment: string;
}

export interface UvInfo {
  executable: string;
  version: string;
}

const PYTHON_PROBE = `
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
    library_directories = [
        sysconfig.get_config_var("LIBDIR"),
        sysconfig.get_config_var("LIBPL"),
        os.path.join(base_prefix, "lib"),
    ]
    library_names = [
        sysconfig.get_config_var("LDLIBRARY"),
        sysconfig.get_config_var("LIBRARY"),
    ]
    for directory in library_directories:
        for name in library_names:
            if directory and name:
                library_candidates.append(os.path.join(directory, name))

library_path = next((candidate for candidate in library_candidates if os.path.isfile(candidate)), "")
embedding = None
if os.path.isfile(header_path) and library_path:
    library_name = os.path.basename(library_path)
    library_kind = "import" if os.name == "nt" else ("static" if library_name.endswith(".a") else "shared")
    embedding = {
        "includeDirectory": include_directory,
        "headerPath": header_path,
        "libraryPath": library_path,
        "libraryDirectory": os.path.dirname(library_path),
        "libraryName": library_name,
        "libraryKind": library_kind,
    }

release_level = sys.version_info.releaselevel
release_suffix = "" if release_level == "final" else f"-{release_level}.{sys.version_info.serial}"

print(json.dumps({
    "executable": sys.executable,
    "baseExecutable": getattr(sys, "_base_executable", sys.executable),
    "version": ".".join(map(str, sys.version_info[:3])) + release_suffix,
    "major": sys.version_info.major,
    "minor": sys.version_info.minor,
    "patch": sys.version_info.micro,
    "releaseLevel": release_level,
    "implementation": sys.implementation.name,
    "architecture": platform.machine().lower(),
    "pointerBits": struct.calcsize("P") * 8,
    "prefix": sys.prefix,
    "basePrefix": base_prefix,
    "virtualEnvironment": sys.prefix if sys.prefix != base_prefix else None,
    "gilDisabled": bool(sysconfig.get_config_var("Py_GIL_DISABLED")),
    "embedding": embedding,
}))
`;

export async function findPython(options: ResolvedPyfigOptions): Promise<PythonInfo | null> {
  const candidates: CommandSpec[] = [];
  if (options.python) candidates.push({ executable: options.python, args: [] });
  if (process.platform === 'win32') {
    candidates.push(
      { executable: 'python', args: [] },
      { executable: 'python3', args: [] },
      { executable: 'py', args: ['-3'] },
    );
  } else {
    candidates.push(
      ...['python3.15', 'python3.14', 'python3.13', 'python3.12', 'python3.11', 'python3.10']
        .map((executable) => ({ executable, args: [] })),
      { executable: 'python3', args: [] },
      { executable: 'python', args: [] },
    );
  }

  for (const candidate of candidates) {
    const info = await probePython(candidate, options);
    if (info && pythonSatisfiesRequirements(info, options)) return info;
  }
  return null;
}

export function pythonSatisfiesRequirements(
  python: PythonInfo,
  options: Pick<ResolvedPyfigOptions, 'pythonRange' | 'requireEmbedding' | 'requireGil'>,
): boolean {
  return semver.satisfies(python.version, options.pythonRange) &&
    (!options.requireEmbedding || (
      python.implementation === 'cpython' &&
      python.embedding !== null &&
      pythonArchitectureMatchesRuntime(python)
    )) &&
    (!options.requireGil || !python.gilDisabled);
}

export async function probePython(
  candidate: CommandSpec,
  options: ResolvedPyfigOptions,
): Promise<PythonInfo | null> {
  const executable = await resolveExecutable(candidate.executable, options.env);
  if (!executable) return null;
  try {
    const { stdout } = run(
      executable,
      [...candidate.args, '-c', PYTHON_PROBE],
      options.env,
      options.probeTimeoutMs,
    );
    const info = JSON.parse(stdout.trim()) as PythonInfo;
    return semver.valid(info.version) ? info : null;
  } catch {
    return null;
  }
}

export async function findPip(
  python: PythonInfo,
  options: ResolvedPyfigOptions,
): Promise<PackageManagerInfo | null> {
  if (!python.virtualEnvironment) {
    throw new Error('pip discovery requires a virtual-environment Python interpreter.');
  }
  const activeEnv = activateVirtualEnvironment(
    options.env,
    python.virtualEnvironment,
    python.executable,
  );
  try {
    const { stdout } = run(
      python.executable,
      ['-m', 'pip', '--version'],
      activeEnv,
      options.probeTimeoutMs,
    );
    const details = parsePipVersionOutput(stdout);
    const version = normalizeVersion(details?.version);
    if (!version || !semver.satisfies(version, options.pipRange)) return null;
    if (!details || !pipBelongsToPython(details, python)) return null;
    return {
      kind: 'pip',
      executable: python.executable,
      prefixArgs: ['-m', 'pip'],
      version,
      pythonExecutable: python.executable,
      virtualEnvironment: python.virtualEnvironment,
    };
  } catch {
    return null;
  }
}

export interface PipVersionDetails {
  version: string;
  location: string;
  pythonMajor: number;
  pythonMinor: number;
}

export function parsePipVersionOutput(output: string): PipVersionDetails | null {
  const match = output.trim().match(
    /^pip\s+(\S+)\s+from\s+(.+?)\s+\(python\s+(\d+)\.(\d+)(?:\.\d+)?\)$/iu,
  );
  if (!match?.[1] || !match[2] || !match[3] || !match[4]) return null;
  return {
    version: match[1],
    location: match[2],
    pythonMajor: Number.parseInt(match[3], 10),
    pythonMinor: Number.parseInt(match[4], 10),
  };
}

export function pipBelongsToPython(
  pip: PipVersionDetails,
  python: PythonInfo,
): boolean {
  if (pip.pythonMajor !== python.major || pip.pythonMinor !== python.minor) return false;

  const prefix = normalizePathForComparison(path.resolve(python.prefix));
  const location = normalizePathForComparison(path.resolve(pip.location));
  const relative = path.relative(prefix, location);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export async function findUv(options: ResolvedPyfigOptions): Promise<UvInfo | null> {
  const configured = options.env['PYFIG_UV'] ?? 'uv';
  const executable = await resolveExecutable(configured, options.env);
  const uv = executable ? probeUv(executable, options) : null;
  return uv && semver.satisfies(uv.version, options.uvRange) ? uv : null;
}

export function probeUv(
  executable: string,
  options: ResolvedPyfigOptions,
): UvInfo | null {
  try {
    const { stdout } = run(executable, ['--version'], options.env, options.probeTimeoutMs);
    const version = normalizeVersion(stdout.match(/^uv\s+(\S+)/iu)?.[1]);
    return version ? { executable, version } : null;
  } catch {
    return null;
  }
}

function normalizeVersion(value: string | undefined): string | null {
  if (!value) return null;
  return semver.valid(value) ?? semver.coerce(value)?.version ?? null;
}

function normalizePathForComparison(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function pythonArchitectureMatchesRuntime(python: PythonInfo): boolean {
  const architecture = python.architecture.toLowerCase();
  if (python.pointerBits !== (process.arch === 'ia32' ? 32 : 64)) return false;
  if (process.arch === 'x64') return architecture === 'x86_64' || architecture === 'amd64';
  if (process.arch === 'arm64') return architecture === 'aarch64' || architecture === 'arm64';
  if (process.arch === 'ia32') {
    return architecture === 'x86' || architecture === 'i386' || architecture === 'i686';
  }
  return architecture === process.arch;
}
