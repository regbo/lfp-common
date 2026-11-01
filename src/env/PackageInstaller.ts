/**
 * pynect - PackageInstaller
 *
 * Repository-venv package installer. All Python and pip execution is routed
 * through Pyfig so standalone or system pip can never be selected.
 *
 * Responsibilities
 *
 * - Resolve the "import name" from the "install name" (e.g. scikit-learn -> sklearn)
 * - Check whether a package is already importable before trying to install it
 * - Run pip with the correct flags (--quiet, --no-warn-script-location, etc.)
 * - Support per-package version constraints  ("numpy>=1.24,<2")
 * - Support extras  ("uvicorn[standard]")
 * - Support index overrides  (corporate PyPI mirrors, --extra-index-url)
 * - Upgrade existing installations when requested
 * - Emit structured progress events via EventEmitter
 * - Retry transient network failures up to N times with back-off
 * - Parse pip's JSON output (--report) for installed metadata when available
 * - Return full InstallResult objects describing what happened
 *
 * Usage
 *
 * const installer = new PackageInstaller({ pythonExecutable: '/usr/bin/python3' });
 *
 * const result = await installer.install(['pandas', 'numpy>=1.24', 'torch']);
 * console.log(result.installed);   // ['pandas==2.2.2', 'numpy==1.26.4', ...]
 *
 * installer.on('progress', (ev) => console.log(ev.package, ev.status));
 */

import { EventEmitter } from 'events';
import * as fs   from 'fs';
import * as path from 'path';
import { Logger } from '../utils/Logger';
import { assertPythonPackageSpec, isPythonModuleName } from './executables';
import { loadPyfig, pynectPyfigOptions } from './PyfigAdapter';

const logger = new Logger('PackageInstaller');

// Public types

/** A single package specification that can be installed. */
export interface PackageSpec {
  /** Raw pip spec: "pandas", "numpy>=1.24,<2", "torch==2.3.0+cu121" */
  spec: string;
  /**
   * Override the import (module) name used to test whether the package is
   * already importable.  Defaults to the auto-detected mapping.
   * e.g. spec="scikit-learn" -> importName="sklearn"
   */
  importName?: string;
  /** Force reinstall even if already importable. */
  forceReinstall?: boolean;
  /** Install pre-release versions */
  preRelease?: boolean;
}

/** Options passed to the PackageInstaller constructor. */
export interface PackageInstallerOptions {
  /** Python executable to use for pip invocations. Required. */
  pythonExecutable: string;
  /**
   * Extra --index-url override (corporate mirror etc.)
   * If omitted, pip uses its default index.
   */
  indexUrl?: string;
  /**
   * Additional --extra-index-url entries (e.g. CUDA wheels).
   * Supports multiple URLs.
   */
  extraIndexUrls?: string[];
  /**
   * Trusted hosts (--trusted-host) required when using HTTP mirrors.
   */
  trustedHosts?: string[];
  /**
   * Maximum retry attempts for transient network errors.  Default: 3.
   */
  maxRetries?: number;
  /**
   * Base delay (ms) between retry attempts.  Each retry doubles.  Default: 1000.
   */
  retryDelayMs?: number;
  /**
   * Working directory for pip.  Defaults to process.cwd().
   */
  cwd?: string;
  /**
   * Additional environment variables to inject into pip subprocess.
   */
  env?: Record<string, string>;
  /**
   * Timeout (ms) per pip invocation.  Default: 300 000 (5 min).
   */
  timeoutMs?: number;
  /**
   * If true, pass --quiet to suppress pip chatter.  Default: true.
   */
  quiet?: boolean;
  /**
   * If true, pass --upgrade to pip for already-installed packages.  Default: false.
   */
  upgrade?: boolean;
}

/** Status of a single package during/after installation. */
export type PackageStatus =
  | 'already_installed'
  | 'installing'
  | 'installed'
  | 'upgraded'
  | 'failed'
  | 'skipped';

/** Progress event emitted during installation. */
export interface InstallProgressEvent {
  package: string;
  status: PackageStatus;
  version?: string;
  error?: string;
}

/** Aggregated result of an install() call. */
export interface InstallResult {
  /** Packages that were successfully installed or upgraded (with versions). */
  installed: string[];
  /** Packages that were already present and did not need installation. */
  alreadyInstalled: string[];
  /** Packages that failed to install. */
  failed: Array<{ spec: string; error: string }>;
  /** Whether every requested package ended up available. */
  success: boolean;
  /** Combined stdout/stderr from pip (useful for debugging). */
  output: string;
}

/** Metadata returned by `pip show`. */
export interface PackageMetadata {
  name: string;
  version: string;
  location: string;
  requires: string[];
  requiredBy: string[];
  summary: string;
}

// Import-name alias table
// Maps pip install name -> Python import name.
// Only entries that differ from the install name need to be listed here.

const INSTALL_TO_IMPORT: Record<string, string> = {
  'scikit-learn':       'sklearn',
  'scikit_learn':       'sklearn',
  'Pillow':             'PIL',
  'pillow':             'PIL',
  'opencv-python':      'cv2',
  'opencv-python-headless': 'cv2',
  'opencv_python':      'cv2',
  'beautifulsoup4':     'bs4',
  'beautifulsoup':      'bs4',
  'pyyaml':             'yaml',
  'PyYAML':             'yaml',
  'python-dateutil':    'dateutil',
  'python_dateutil':    'dateutil',
  'typing-extensions':  'typing_extensions',
  'typing_extensions':  'typing_extensions',
  'pyzmq':              'zmq',
  'Pyzmq':              'zmq',
  'protobuf':           'google.protobuf',
  'grpcio':             'grpc',
  'psutil':             'psutil',
  'python-dotenv':      'dotenv',
  'python_dotenv':      'dotenv',
  'Werkzeug':           'werkzeug',
  'Flask':              'flask',
  'Django':             'django',
  'Jinja2':             'jinja2',
  'SQLAlchemy':         'sqlalchemy',
  'alembic':            'alembic',
  'aiohttp':            'aiohttp',
  'httpx':              'httpx',
  'fastapi':            'fastapi',
  'starlette':          'starlette',
  'uvicorn':            'uvicorn',
  'gunicorn':           'gunicorn',
  'celery':             'celery',
  'redis':              'redis',
  'pymongo':            'pymongo',
  'motor':              'motor',
  'aiomysql':           'aiomysql',
  'asyncpg':            'asyncpg',
  'psycopg2':           'psycopg2',
  'psycopg2-binary':    'psycopg2',
  'psycopg2_binary':    'psycopg2',
  'boto3':              'boto3',
  'botocore':           'botocore',
  'google-cloud-storage': 'google.cloud.storage',
  'google-auth':        'google.auth',
  'azure-storage-blob': 'azure.storage.blob',
  'minio':              'minio',
  'transformers':       'transformers',
  'datasets':           'datasets',
  'tokenizers':         'tokenizers',
  'diffusers':          'diffusers',
  'accelerate':         'accelerate',
  'peft':               'peft',
  'trl':                'trl',
  'sentence-transformers': 'sentence_transformers',
  'sentence_transformers': 'sentence_transformers',
  'faiss-cpu':          'faiss',
  'faiss-gpu':          'faiss',
  'annoy':              'annoy',
  'chromadb':           'chromadb',
  'pinecone-client':    'pinecone',
  'weaviate-client':    'weaviate',
  'langchain':          'langchain',
  'openai':             'openai',
  'anthropic':          'anthropic',
  'tiktoken':           'tiktoken',
  'matplotlib':         'matplotlib',
  'seaborn':            'seaborn',
  'plotly':             'plotly',
  'bokeh':              'bokeh',
  'altair':             'altair',
  'scipy':              'scipy',
  'statsmodels':        'statsmodels',
  'lightgbm':           'lightgbm',
  'xgboost':            'xgboost',
  'catboost':           'catboost',
  'shap':               'shap',
  'lime':               'lime',
  'sympy':              'sympy',
  'networkx':           'networkx',
  'pyarrow':            'pyarrow',
  'pyarrow[flight]':    'pyarrow',
  'polars':             'polars',
  'dask':               'dask',
  'ray':                'ray',
  'pydantic':           'pydantic',
  'pydantic-settings':  'pydantic_settings',
  'attrs':              'attr',
  'cattrs':             'cattr',
  'click':              'click',
  'typer':              'typer',
  'rich':               'rich',
  'tqdm':               'tqdm',
  'loguru':             'loguru',
  'structlog':          'structlog',
  'pendulum':           'pendulum',
  'arrow':              'arrow',
  'humanize':           'humanize',
  'tabulate':           'tabulate',
  'prettytable':        'prettytable',
  'orjson':             'orjson',
  'ujson':              'ujson',
  'msgpack':            'msgpack',
  'lz4':                'lz4',
  'zstandard':          'zstd',
  'cryptography':       'cryptography',
  'paramiko':           'paramiko',
  'fabric':             'fabric',
  'invoke':             'invoke',
  'pytest':             'pytest',
  'hypothesis':         'hypothesis',
  'mock':               'unittest.mock',
  'freezegun':          'freezegun',
  'factory-boy':        'factory',
  'Faker':              'faker',
};

// Helpers

/**
 * Extract the bare package name from a spec string.
 * "numpy>=1.24,<2" -> "numpy"
 * "torch==2.3.0+cu121" -> "torch"
 * "uvicorn[standard]" -> "uvicorn"
 */
function extractPackageName(spec: string): string {
  // Remove VCS prefixes (git+https://...)
  if (spec.startsWith('git+') || spec.startsWith('hg+') || spec.startsWith('svn+')) {
    const eggIndex = spec.indexOf('#egg=');
    if (eggIndex !== -1) {return spec.slice(eggIndex + 5).split('&')[0]!.trim();}
    return spec;
  }
  // Remove extras [...], then split on version specifiers
  return spec.replace(/\[.*?\]/g, '').split(/[><=!~;]/)[0]!.trim();
}

/**
 * Determine the Python import name for a given install spec.
 */
function resolveImportName(spec: string, override?: string): string {
  if (override) {return override;}
  const bare = extractPackageName(spec);
  return INSTALL_TO_IMPORT[bare] ?? bare.replace(/-/g, '_');
}

/** Sleep helper. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// PackageInstaller

export class PackageInstaller extends EventEmitter {
  private readonly _python: string;
  private readonly _opts:   Required<PackageInstallerOptions>;

  constructor(options: PackageInstallerOptions) {
    super();
    this._python = options.pythonExecutable;
    this._opts = {
      pythonExecutable: options.pythonExecutable,
      indexUrl:         options.indexUrl         ?? '',
      extraIndexUrls:   options.extraIndexUrls    ?? [],
      trustedHosts:     options.trustedHosts      ?? [],
      maxRetries:       options.maxRetries        ?? 3,
      retryDelayMs:     options.retryDelayMs      ?? 1000,
      cwd:              options.cwd               ?? process.cwd(),
      env:              options.env               ?? {},
      timeoutMs:        options.timeoutMs         ?? 300_000,
      quiet:            options.quiet             !== false,
      upgrade:          options.upgrade           ?? false,
    };
  }

  // Public API

  /**
   * Install one or more packages.
   *
   * @param packages - Array of pip spec strings or PackageSpec objects.
   * @returns InstallResult describing what happened to each package.
   */
  async install(packages: Array<string | PackageSpec>): Promise<InstallResult> {
    const specs = packages.map((p) =>
      typeof p === 'string' ? { spec: p } as PackageSpec : p
    );
    for (const item of specs) {
      assertPythonPackageSpec(item.spec);
      if (item.importName && !isPythonModuleName(item.importName)) {
        throw new TypeError(`Invalid Python import name: ${item.importName}`);
      }
    }

    const result: InstallResult = {
      installed:        [],
      alreadyInstalled: [],
      failed:           [],
      success:          false,
      output:           '',
    };

    const toInstall: PackageSpec[] = [];

    // 1. Pre-flight: check which are already importable
    for (const spec of specs) {
      const importName = resolveImportName(spec.spec, spec.importName);
      if (!spec.forceReinstall && !this._opts.upgrade && this._isImportable(importName)) {
        logger.debug(`Already importable: ${importName} (${spec.spec})`);
        result.alreadyInstalled.push(spec.spec);
        this._emit('already_installed', spec.spec);
      } else {
        toInstall.push(spec);
      }
    }

    if (toInstall.length === 0) {
      result.success = true;
      return result;
    }

    // 2. Install in a single pip invocation where possible
    // Group specs that do not need individual treatment
    const batchSpecs  = toInstall.filter((s) => !s.preRelease);
    const prerelSpecs = toInstall.filter((s) => s.preRelease);

    const outputs: string[] = [];

    if (batchSpecs.length > 0) {
      const { out, perPackageResults } = await this._pipInstall(batchSpecs, false);
      outputs.push(out);
      this._mergeResults(result, perPackageResults);
    }

    if (prerelSpecs.length > 0) {
      const { out, perPackageResults } = await this._pipInstall(prerelSpecs, true);
      outputs.push(out);
      this._mergeResults(result, perPackageResults);
    }

    result.output  = outputs.join('\n');
    result.success = result.failed.length === 0;
    return result;
  }

  /**
   * Install a single package and return the installed version string.
   * Throws on failure.
   */
  async installOne(spec: string, options?: Partial<PackageSpec>): Promise<string> {
    const result = await this.install([{ spec, ...options }]);
    if (!result.success) {
      const err = result.failed[0];
      throw new Error(`Failed to install ${spec}: ${err?.error ?? 'unknown error'}`);
    }
    return this.getVersion(extractPackageName(spec)) ?? spec;
  }

  /**
   * Upgrade a package to the latest version.
   */
  async upgrade(spec: string): Promise<string> {
    return this.installOne(spec, { forceReinstall: false });
  }

  /**
   * Uninstall one or more packages.
   */
  async uninstall(packages: string[]): Promise<void> {
    if (packages.length === 0) {return;}
    packages.forEach(assertPythonPackageSpec);

    const args = ['uninstall', '-y', ...packages];
    logger.info(`Uninstalling: ${packages.join(', ')}`);

    const result = loadPyfig().pipSpawnSync(args, {
      encoding: 'utf8',
      cwd:      this._opts.cwd,
      env:      { ...process.env, ...this._opts.env },
    }, this._pyfigOptions());

    if (result.status !== 0) {
      throw new Error(`pip uninstall failed:\n${result.stderr}`);
    }
  }

  /**
   * Check whether a package is currently importable by Python.
   */
  isImportable(importName: string): boolean {
    return this._isImportable(importName);
  }

  /**
   * Check whether a package (by install name) is installed and return
   * its version string, or null if not installed.
   */
  getVersion(packageName: string): string | null {
    const args = ['show', '--quiet', packageName];
    const r = loadPyfig().pipSpawnSync(args, {
      encoding: 'utf8',
      env:      { ...process.env, ...this._opts.env },
    }, this._pyfigOptions());
    const stdout = String(r.stdout ?? '');
    if (r.status !== 0 || !stdout) {return null;}
    const match = stdout.match(/^Version:\s*(.+)$/m);
    return match ? match[1]!.trim() : null;
  }

  /**
   * Return full metadata for an installed package.
   */
  getMetadata(packageName: string): PackageMetadata | null {
    const args = ['show', packageName];
    const r = loadPyfig().pipSpawnSync(args, {
      encoding: 'utf8',
      env:      { ...process.env, ...this._opts.env },
    }, this._pyfigOptions());
    const stdout = String(r.stdout ?? '');
    if (r.status !== 0 || !stdout) {return null;}
    return this._parsePipShow(stdout);
  }

  /**
   * List all packages installed in the current Python environment.
   */
  listInstalled(): Array<{ name: string; version: string }> {
    const args = ['list', '--format=json'];
    const r = loadPyfig().pipSpawnSync(args, {
      encoding: 'utf8',
      env:      { ...process.env, ...this._opts.env },
    }, this._pyfigOptions());
    const stdout = String(r.stdout ?? '');
    if (r.status !== 0 || !stdout) {return [];}
    try {
      return JSON.parse(stdout) as Array<{ name: string; version: string }>;
    } catch {
      return [];
    }
  }

  /**
   * Check which packages from the given list are missing.
   *
   * @param packages - Array of pip spec strings.
   * @returns Array of spec strings that are NOT currently importable.
   */
  getMissing(packages: string[]): string[] {
    return packages.filter((spec) => {
      const importName = resolveImportName(spec);
      return !this._isImportable(importName);
    });
  }

  /**
   * Ensure pip itself is up-to-date.
   */
  async upgradePip(): Promise<void> {
    logger.info('Upgrading pip...');
    const args = ['install', '--upgrade', 'pip'];
    const r = loadPyfig().pipSpawnSync(args, {
      encoding: 'utf8',
      cwd:      this._opts.cwd,
      env:      { ...process.env, ...this._opts.env },
    }, this._pyfigOptions());
    if (r.status !== 0) {
      logger.warn(`pip self-upgrade failed (non-fatal):\n${r.stderr}`);
    }
  }

  // Private helpers

  /**
   * Run `python -c "import X"` to test importability.
   * This is faster than `pip show` for the common case.
   */
  private _isImportable(importName: string): boolean {
    // Handle dotted names like "google.protobuf"
    const topLevel = importName.split('.')[0]!;
    if (!isPythonModuleName(topLevel)) return false;
    const code = `import importlib; importlib.import_module(${JSON.stringify(topLevel)})`;
    const r = loadPyfig().pythonSpawnSync(['-c', code], {
      encoding: 'utf8',
      env:      { ...process.env, ...this._opts.env },
    }, this._pyfigOptions());
    return r.status === 0;
  }

  /**
   * Build pip install argument list.
   */
  private _buildPipArgs(specs: PackageSpec[], preRelease: boolean): string[] {
    const args: string[] = ['install'];

    if (this._opts.quiet)   {args.push('--quiet');}
    if (this._opts.upgrade) {args.push('--upgrade');}
    if (preRelease)         {args.push('--pre');}

    args.push('--no-warn-script-location');
    args.push('--disable-pip-version-check');

    if (this._opts.indexUrl) {
      args.push('--index-url', this._opts.indexUrl);
    }
    for (const url of this._opts.extraIndexUrls) {
      args.push('--extra-index-url', url);
    }
    for (const host of this._opts.trustedHosts) {
      args.push('--trusted-host', host);
    }

    for (const s of specs) {
      if (s.forceReinstall) {args.push('--force-reinstall');}
      args.push(s.spec);
    }

    return args;
  }

  /**
   * Execute pip install with retry logic.
   */
  private async _pipInstall(
    specs: PackageSpec[],
    preRelease: boolean
  ): Promise<{ out: string; perPackageResults: Array<{ spec: string; status: PackageStatus; version?: string; error?: string }> }> {
    const args     = this._buildPipArgs(specs, preRelease);
    const specList = specs.map((s) => s.spec).join(', ');

    logger.info(`pip install: ${specList}`);
    specs.forEach((s) => this._emit('installing', s.spec));

    let lastError = '';
    let lastOut   = '';

    for (let attempt = 1; attempt <= this._opts.maxRetries; attempt++) {
      const { exitCode, stdout } = await this._runPip(args);
      lastOut = stdout;

      if (exitCode === 0) {
        // Success - resolve versions
        const results = specs.map((s) => {
          const name    = extractPackageName(s.spec);
          const version = this.getVersion(name) ?? undefined;
          this._emit('installed', s.spec, version);
          return { spec: s.spec, status: 'installed' as PackageStatus, version };
        });
        return { out: stdout, perPackageResults: results };
      }

      lastError = stdout;
      const isNetworkError = /connection error|timed out|network/i.test(stdout);

      if (!isNetworkError || attempt === this._opts.maxRetries) {
        break;
      }

      const delay = this._opts.retryDelayMs * 2 ** (attempt - 1);
      logger.warn(`pip attempt ${attempt} failed (network). Retrying in ${delay}ms`);
      await sleep(delay);
    }

    // Failure path - try each spec individually to isolate the bad one
    const results: Array<{ spec: string; status: PackageStatus; version?: string; error?: string }> = [];

    if (specs.length > 1) {
      logger.warn('Batch install failed; falling back to per-package install');
      for (const s of specs) {
        const single = await this._pipInstall([s], preRelease);
        results.push(...single.perPackageResults);
      }
    } else {
      const s = specs[0]!;
      logger.error(`Failed to install ${s.spec}: ${lastError.slice(0, 200)}`);
      this._emit('failed', s.spec, undefined, lastError);
      results.push({ spec: s.spec, status: 'failed', error: lastError });
    }

    return { out: lastOut, perPackageResults: results };
  }

  /**
   * Spawn pip and collect output.
   */
  private async _runPip(args: string[]): Promise<{ exitCode: number; stdout: string }> {
    const proc = await loadPyfig().pipSpawn(args, {
        cwd:     this._opts.cwd,
        env:     { ...process.env, ...this._opts.env },
        stdio:   ['ignore', 'pipe', 'pipe'],
      }, this._pyfigOptions());

    return new Promise((resolve) => {
      let stdout = '';
      proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr?.on('data', (d: Buffer) => { stdout += d.toString(); });

      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        stdout += '\n[TIMEOUT]';
      }, this._opts.timeoutMs);

      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code ?? 1, stdout });
      });
    });
  }

  private _pyfigOptions(): object {
    return pynectPyfigOptions({
      projectRoot: this._opts.cwd,
      pythonPath: this._python,
      env: this._opts.env,
    });
  }

  /** Merge per-package results into the aggregate InstallResult. */
  private _mergeResults(
    result: InstallResult,
    perPackage: Array<{ spec: string; status: PackageStatus; version?: string; error?: string }>
  ): void {
    for (const r of perPackage) {
      if (r.status === 'installed' || r.status === 'upgraded') {
        result.installed.push(r.version ? `${r.spec}==${r.version}` : r.spec);
      } else if (r.status === 'already_installed') {
        result.alreadyInstalled.push(r.spec);
      } else if (r.status === 'failed') {
        result.failed.push({ spec: r.spec, error: r.error ?? 'unknown' });
      }
    }
  }

  /** Emit a typed progress event. */
  private _emit(
    status: PackageStatus,
    pkg:     string,
    version?: string,
    error?:   string
  ): void {
    const ev: InstallProgressEvent = { package: pkg, status, version, error };
    this.emit('progress', ev);
  }

  /** Parse `pip show` output into PackageMetadata. */
  private _parsePipShow(raw: string): PackageMetadata {
    const get = (field: string): string => {
      const m = raw.match(new RegExp(`^${field}:\\s*(.*)$`, 'm'));
      return m ? m[1]!.trim() : '';
    };
    const getList = (field: string): string[] => {
      const val = get(field);
      return val ? val.split(/,\s*/).filter(Boolean) : [];
    };
    return {
      name:       get('Name'),
      version:    get('Version'),
      location:   get('Location'),
      summary:    get('Summary'),
      requires:   getList('Requires'),
      requiredBy: getList('Required-by'),
    };
  }
}

// Factory helpers

/**
 * Create an installer seeded from a system Python, but always target the
 * repository-root .venv selected by Pyfig.
 */
export function createSystemInstaller(
  options?: Partial<Omit<PackageInstallerOptions, 'pythonExecutable'>>
): PackageInstaller {
  const python = process.env['PYNECT_PYTHON'] ?? '';
  return new PackageInstaller({ pythonExecutable: python, ...options });
}

/**
 * Create a PackageInstaller tied to a specific virtualenv directory.
 */
export function createVenvInstaller(
  venvDir:  string,
  options?: Partial<Omit<PackageInstallerOptions, 'pythonExecutable'>>
): PackageInstaller {
  if (path.basename(path.resolve(venvDir)).toLowerCase() !== '.venv') {
    throw new Error('Pynect only supports a repository-root .venv directory.');
  }
  const bin = process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');

  if (!fs.existsSync(bin)) {
    throw new Error(`Virtualenv python not found at: ${bin}`);
  }
  return new PackageInstaller({
    pythonExecutable: bin,
    cwd: path.dirname(path.resolve(venvDir)),
    ...options,
  });
}

/**
 * Resolve the import name from a pip install spec using the built-in table.
 * Exposed for testing and introspection.
 */
export { resolveImportName, extractPackageName, INSTALL_TO_IMPORT };
