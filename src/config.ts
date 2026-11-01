import path from 'node:path';
import * as envPaths from 'env-paths';
import semver from 'semver';
import { resolveProjectRoot } from './project-root.js';
import { isValidPythonSpecifier, pythonVersionSatisfies } from './python-version.js';

export const DEFAULT_REQUIRES_PYTHON = '>=3.10,<4';
export const DEFAULT_MANAGED_PYTHON = '3.12';
export const DEFAULT_UV_VERSION = '0.13.6';
// External uv only needs to support the command and isolation flags Pyfig uses.
// Keep that compatibility floor separate from the newer version Pyfig installs.
export const DEFAULT_UV_RANGE = '>=0.10.0 <1.0.0';

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

// Bun's CommonJS bundler wraps an external ESM default one level deeper than
// Node.js. Normalize that boundary once instead of leaking runtime checks into
// configuration resolution.
const envPathsFunction = (() => {
  const imported = envPaths.default as typeof envPaths.default | {
    default?: typeof envPaths.default;
  };
  const implementation = typeof imported === 'function' ? imported : imported.default;
  if (!implementation) throw new TypeError('env-paths did not expose its default function.');
  return implementation;
})();

export interface PyfigOptions {
  /** Exact interpreter path that an existing or newly created venv must derive from. */
  python?: string;
  /** PEP 440 Python version specifier, matching pyproject.toml requires-python. */
  requiresPython?: string;
  /** uv Python request used only when no compatible interpreter exists. */
  managedPython?: string;
  /** Exact uv release installed into Pyfig's private cache. */
  uvVersion?: string;
  /** Accepted range for an externally installed uv executable. */
  uvRange?: string;
  /** Require Python development headers and a linkable CPython library. */
  requireEmbedding?: boolean;
  /** Reject free-threaded CPython builds when the consumer requires the GIL ABI. */
  requireGil?: boolean;
  /** Shared default for the three specific setup policies. */
  autoInstall?: boolean;
  /** Allow uv to install a managed Python when no compatible interpreter exists. */
  installPython?: boolean;
  /** Allow Pyfig to install its pinned, checksum-verified uv executable. */
  installUv?: boolean;
  /** Allow creation of Pyfig's private environment under node_modules. */
  createVirtualEnvironment?: boolean;
  /** Private cache root for uv, managed Python, downloads, and coordination. */
  cacheDir?: string;
  /** Repository root that owns node_modules/.pyfig. */
  projectRoot?: string;
  /** Maximum duration of one executable capability probe. */
  probeTimeoutMs?: number;
  /** Maximum duration of a Python, uv, or venv installation subprocess. */
  installTimeoutMs?: number;
  /** Maximum duration of one uv archive or checksum request. */
  downloadTimeoutMs?: number;
  /** Maximum wait for another worker or process provisioning the same resource. */
  coordinationTimeoutMs?: number;
  /** Complete child environment and configuration source for this invocation. */
  env?: NodeJS.ProcessEnv;
}

export interface ResolvedPyfigOptions {
  python: string;
  requiresPython: string;
  managedPython: string;
  uvVersion: string;
  uvRange: string;
  requireEmbedding: boolean;
  requireGil: boolean;
  autoInstall: boolean;
  installPython: boolean;
  installUv: boolean;
  createVirtualEnvironment: boolean;
  cacheDir: string;
  projectRoot: string;
  probeTimeoutMs: number;
  installTimeoutMs: number;
  downloadTimeoutMs: number;
  coordinationTimeoutMs: number;
  env: NodeJS.ProcessEnv;
}

export function resolveOptions(options: PyfigOptions = {}): ResolvedPyfigOptions {
  // Snapshot the environment so callers cannot change an in-flight policy by
  // mutating process.env or a reused options object after resolution.
  const env = { ...(options.env ?? process.env) };
  const requiresPython = options.requiresPython ??
    env['PYFIG_REQUIRES_PYTHON'] ?? DEFAULT_REQUIRES_PYTHON;
  const uvRange = options.uvRange ?? env['PYFIG_UV_RANGE'] ?? DEFAULT_UV_RANGE;
  assertPythonSpecifier(requiresPython);
  assertRange('uv', uvRange);

  const managedPython = options.managedPython ??
    env['PYFIG_MANAGED_PYTHON'] ?? DEFAULT_MANAGED_PYTHON;
  const uvVersion = options.uvVersion ?? env['PYFIG_UV_VERSION'] ?? DEFAULT_UV_VERSION;
  assertManagedPythonRequest(managedPython, requiresPython);
  assertUvVersion(uvVersion, uvRange);

  const probeTimeoutMs = resolveDuration(
    'probeTimeoutMs',
    options.probeTimeoutMs,
    env['PYFIG_PROBE_TIMEOUT_MS'],
    DEFAULT_PROBE_TIMEOUT_MS,
  );
  const installTimeoutMs = resolveDuration(
    'installTimeoutMs',
    options.installTimeoutMs,
    env['PYFIG_INSTALL_TIMEOUT_MS'],
    DEFAULT_INSTALL_TIMEOUT_MS,
  );
  const downloadTimeoutMs = resolveDuration(
    'downloadTimeoutMs',
    options.downloadTimeoutMs,
    env['PYFIG_DOWNLOAD_TIMEOUT_MS'],
    DEFAULT_DOWNLOAD_TIMEOUT_MS,
  );
  const coordinationTimeoutMs = resolveDuration(
    'coordinationTimeoutMs',
    options.coordinationTimeoutMs,
    env['PYFIG_COORDINATION_TIMEOUT_MS'],
    installTimeoutMs + downloadTimeoutMs + 60_000,
  );
  const configuredHome = options.cacheDir ?? env['PYFIG_HOME'];
  const cacheDir = configuredHome
    ? path.resolve(configuredHome)
    : envPathsFunction('pyfig', { suffix: '' }).cache;
  const configuredProjectRoot = options.projectRoot ?? env['PYFIG_PROJECT_ROOT'];
  const projectRoot = configuredProjectRoot
    ? path.resolve(configuredProjectRoot)
    : resolveProjectRoot(env['INIT_CWD'] ?? process.cwd());
  const autoInstall = options.autoInstall ?? parseBoolean(env['PYFIG_AUTO_INSTALL'], true);

  return {
    python: options.python ?? env['PYFIG_PYTHON'] ?? '',
    requiresPython,
    managedPython,
    uvVersion,
    uvRange,
    requireEmbedding: options.requireEmbedding ?? parseBoolean(env['PYFIG_REQUIRE_EMBEDDING'], false),
    requireGil: options.requireGil ?? parseBoolean(env['PYFIG_REQUIRE_GIL'], false),
    autoInstall,
    installPython: options.installPython ?? parseBoolean(env['PYFIG_INSTALL_PYTHON'], autoInstall),
    installUv: options.installUv ?? parseBoolean(env['PYFIG_INSTALL_UV'], autoInstall),
    createVirtualEnvironment: options.createVirtualEnvironment ??
      parseBoolean(env['PYFIG_CREATE_VIRTUAL_ENVIRONMENT'], autoInstall),
    cacheDir,
    projectRoot,
    probeTimeoutMs,
    installTimeoutMs,
    downloadTimeoutMs,
    coordinationTimeoutMs,
    env,
  };
}

/** Keep uv data private while preferring a compatible system interpreter. */
export function uvEnvironment(options: ResolvedPyfigOptions): NodeJS.ProcessEnv {
  return {
    ...options.env,
    UV_PYTHON_INSTALL_DIR: path.join(options.cacheDir, 'python'),
    UV_CACHE_DIR: path.join(options.cacheDir, 'uv-cache'),
    UV_PYTHON_PREFERENCE: 'system',
    UV_NO_CONFIG: '1',
  };
}

function assertRange(tool: string, range: string): void {
  if (!semver.validRange(range)) {
    throw new TypeError(`Invalid ${tool} SemVer range: ${range}`);
  }
}

function assertUvVersion(version: string, range: string): void {
  if (!semver.valid(version)) {
    throw new TypeError(`Invalid exact uv version: ${version}`);
  }
  if (!semver.satisfies(version, range)) {
    throw new TypeError(`Pinned uv ${version} does not satisfy supported range ${range}.`);
  }
}

function assertPythonSpecifier(specifier: string): void {
  if (!isValidPythonSpecifier(specifier)) {
    throw new TypeError(`Invalid requires-python PEP 440 specifier: ${specifier}`);
  }
}

function assertManagedPythonRequest(request: string, requiresPython: string): void {
  if (!request || /[\\/\0\r\n]/u.test(request) || request.includes('..')) {
    throw new TypeError(`Invalid managed Python request: ${request}`);
  }
  if (/^\d+\.\d+(?:\.\d+)?$/u.test(request)) {
    const normalized = request.split('.').length === 2 ? `${request}.0` : request;
    if (!pythonVersionSatisfies(normalized, requiresPython)) {
      throw new TypeError(
        `Managed Python ${request} cannot satisfy requires-python ${requiresPython}.`,
      );
    }
  }
}

function resolveDuration(
  name: string,
  explicit: number | undefined,
  environment: string | undefined,
  fallback: number,
  allowZero = false,
): number {
  const value = explicit ?? (environment === undefined ? fallback : Number(environment));
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} integer.`);
  }
  return value;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (/^(1|true|yes|on)$/iu.test(value)) return true;
  if (/^(0|false|no|off)$/iu.test(value)) return false;
  throw new TypeError(`Invalid boolean value: ${value}`);
}
