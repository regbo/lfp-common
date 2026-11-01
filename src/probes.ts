import type { ResolvedPyfigOptions } from './config.js';
import { normalizePep440Version, pep440VersionSatisfies } from './pep440.js';
import { resolveExecutable, run, type CommandSpec } from './process.js';

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
release_suffixes = {
    "alpha": "a",
    "beta": "b",
    "candidate": "rc",
    "final": "",
}
release_suffix = release_suffixes[release_level]
if release_suffix:
    release_suffix += str(sys.version_info.serial)

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

export function pythonSatisfiesPolicy(
  python: PythonInfo,
  options: Pick<ResolvedPyfigOptions, 'requiresPython' | 'requireEmbedding' | 'requireGil'>,
): boolean {
  return pep440VersionSatisfies(python.version, options.requiresPython) &&
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
    return normalizePep440Version(info.version) ? info : null;
  } catch {
    return null;
  }
}

export async function findUv(options: ResolvedPyfigOptions): Promise<UvInfo | null> {
  const configured = options.env['PYFIG_UV'] ?? 'uv';
  const executable = await resolveExecutable(configured, options.env);
  const uv = executable ? probeUv(executable, options) : null;
  return uv && pep440VersionSatisfies(uv.version, options.requiresUv) ? uv : null;
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
  return normalizePep440Version(value);
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
