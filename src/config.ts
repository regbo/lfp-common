import path from 'node:path';
import * as envPaths from 'env-paths';
import {
  isValidPep440Specifier,
  pep440VersionSatisfies,
} from './pep440.js';
import { resolveProjectRoot } from './project-root.js';

export const DEFAULT_REQUIRES_PYTHON = '>=3.10,<4';
export const DEFAULT_MANAGED_PYTHON = '3.12';
// External uv only needs to support the command and isolation flags Pyfig uses.
// The installer resolves the greatest published release allowed by this policy.
export const DEFAULT_REQUIRES_UV = '>=0.10,<1';

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
  /** PEP 508 runtime dependencies resolved into this environment's private venv. */
  dependencies?: readonly string[];
  /** Explicit requirements files resolved into this environment's private venv. */
  requirements?: readonly string[];
  /** Exact interpreter path that an existing or newly created venv must derive from. */
  python?: string;
  /** PEP 440 Python version specifier accepted for the selected interpreter. */
  requiresPython?: string;
  /** uv Python request used only when no compatible interpreter exists. */
  managedPython?: string;
  /** PEP 440 version specifier accepted for an existing or managed uv executable. */
  requiresUv?: string;
  /** Require Python development headers and a linkable CPython library. */
  requireEmbedding?: boolean;
  /** Reject free-threaded CPython builds when the consumer requires the GIL ABI. */
  requireGil?: boolean;
  /** Shared default for the three specific setup policies. */
  autoInstall?: boolean;
  /** Allow uv to install a managed Python when no compatible interpreter exists. */
  installPython?: boolean;
  /** Allow Pyfig to install a compatible, checksum-verified uv executable. */
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
  dependencies: readonly string[];
  requirements: readonly string[];
  python: string;
  requiresPython: string;
  managedPython: string;
  requiresUv: string;
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
  const requiresUv = options.requiresUv ?? env['PYFIG_REQUIRES_UV'] ?? DEFAULT_REQUIRES_UV;
  assertPep440Specifier('requires-python', requiresPython);
  assertPep440Specifier('requires-uv', requiresUv);

  const managedPython = options.managedPython ??
    env['PYFIG_MANAGED_PYTHON'] ?? DEFAULT_MANAGED_PYTHON;
  assertManagedPythonRequest(managedPython, requiresPython);

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
  const dependencies = normalizeDependencies(options.dependencies ?? []);
  const requirements = normalizeRequirements(options.requirements ?? [], projectRoot);

  return {
    dependencies,
    requirements,
    python: options.python ?? env['PYFIG_PYTHON'] ?? '',
    requiresPython,
    managedPython,
    requiresUv,
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

export function hasRuntimeRequirements(
  options: Pick<ResolvedPyfigOptions, 'dependencies' | 'requirements'>,
): boolean {
  return options.dependencies.length > 0 || options.requirements.length > 0;
}

/** Keep uv data private while preferring a compatible system interpreter. */
export function uvProcessEnvironment(options: ResolvedPyfigOptions): NodeJS.ProcessEnv {
  return {
    ...options.env,
    UV_PYTHON_INSTALL_DIR: path.join(options.cacheDir, 'python'),
    UV_CACHE_DIR: path.join(options.cacheDir, 'uv-cache'),
    UV_PYTHON_PREFERENCE: 'system',
    UV_NO_CONFIG: '1',
  };
}

function assertPep440Specifier(name: string, specifier: string): void {
  if (!isValidPep440Specifier(specifier)) {
    throw new TypeError(`Invalid ${name} PEP 440 specifier: ${specifier}`);
  }
}

function assertManagedPythonRequest(request: string, requiresPython: string): void {
  if (!request || /[\\/\0\r\n]/u.test(request) || request.includes('..')) {
    throw new TypeError(`Invalid managed Python request: ${request}`);
  }
  if (/^\d+\.\d+(?:\.\d+)?$/u.test(request)) {
    const normalized = request.split('.').length === 2 ? `${request}.0` : request;
    if (!pep440VersionSatisfies(normalized, requiresPython)) {
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

function normalizeDependencies(dependencies: readonly string[]): string[] {
  const normalized = dependencies.map((dependency) => dependency.trim());
  for (const dependency of normalized) {
    if (!dependency || /[\0\r\n]/u.test(dependency)) {
      throw new TypeError(`Invalid runtime dependency: ${JSON.stringify(dependency)}`);
    }
  }
  // uv owns requirement parsing and source priority. Preserve caller order so
  // direct URLs, Git references, local files, and index directives retain uv's semantics.
  return normalized;
}

function normalizeRequirements(requirements: readonly string[], projectRoot: string): string[] {
  const normalized: string[] = [];
  for (const requirement of requirements) {
    const candidate = requirement.trim();
    if (!candidate || /[\0\r\n]/u.test(candidate)) {
      throw new TypeError(`Invalid requirements file path: ${JSON.stringify(candidate)}`);
    }
    const absolute = path.resolve(projectRoot, candidate);
    const basename = path.basename(absolute).toLowerCase();
    if (isPythonProjectFile(basename)) {
      throw new TypeError(
        `Expected a requirements file, not Python project metadata: ${absolute}`,
      );
    }
    normalized.push(absolute);
  }
  return normalized;
}

const PYTHON_PROJECT_FILES = new Set([
  'pdm.lock',
  'pipfile',
  'pipfile.lock',
  'poetry.lock',
  'pyproject.toml',
  'setup.cfg',
  'setup.py',
  'uv.lock',
]);

function isPythonProjectFile(basename: string): boolean {
  return PYTHON_PROJECT_FILES.has(basename) || /^pylock(?:\.[^.]+)?\.toml$/u.test(basename);
}
