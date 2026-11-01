import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { unzipSync } from 'fflate';
import * as tar from 'tar';
import { EnvHttpProxyAgent, fetch } from 'undici';
import {
  resolveOptions,
  uvEnvironment,
  type PyfigOptions,
  type ResolvedPyfigOptions,
} from './config.js';
import { withProvisioningLock } from './provision-lock.js';
import { sanitizeUvEnvironment, uvCommandEnvironment } from './package-target.js';
import {
  maxPep440Version,
  normalizePep440Version,
} from './pep440.js';
import {
  findUv,
  probePython,
  probeUv,
  pythonSatisfiesPolicy,
  type PythonInfo,
  type UvInfo,
} from './probes.js';
import { runAsync } from './process.js';
import {
  canonicalPath,
  externalVirtualEnvironmentDirectories,
  pathsEqual,
  virtualEnvironmentDirectory,
  virtualEnvironmentPythonExecutable,
} from './virtual-environment.js';

export interface PythonEnvironment {
  python: PythonInfo;
  uv: UvInfo;
  /** True when the environment lives in node_modules/.pyfig/venv. */
  managed: boolean;
}

export interface RuntimeDependencyOptions {
  /** Optional-dependency extras read from an existing pyproject.toml. */
  extras?: readonly string[];
  /** Include every optional-dependency extra from an existing pyproject.toml. */
  allExtras?: boolean;
  /** Dependency groups read from an existing pyproject.toml. */
  groups?: readonly string[];
}

/** Ensure a compatible uv executable, preferring an existing installation. */
export async function ensureUv(options: PyfigOptions = {}): Promise<UvInfo> {
  return ensureUvResolved(resolveOptions(options));
}

/**
 * Select a compatible environment and optionally add runtime dependencies.
 * Project dependency files are inputs only and are never changed.
 */
export async function ensureEnvironment(
  options: PyfigOptions = {},
  dependencies: readonly string[] = [],
  dependencyOptions: RuntimeDependencyOptions = {},
): Promise<PythonEnvironment> {
  const resolved = resolveOptions(options);
  const normalized = normalizeDependencies(dependencies);
  const selections = normalizeDependencyOptions(dependencyOptions);
  const uv = await ensureUvResolved(resolved);
  const python = await ensureVirtualEnvironmentResolved(resolved, uv);
  if (normalized.length > 0 || selections.extras.length > 0 ||
      selections.groups.length > 0 || selections.allExtras) {
    await installRuntimeDependencies(uv, python, normalized, selections, resolved);
  }
  return {
    python,
    uv,
    managed: isManagedEnvironment(python, resolved),
  };
}

async function ensureVirtualEnvironmentResolved(
  options: ResolvedPyfigOptions,
  uv: UvInfo,
): Promise<PythonInfo> {
  const existing = await findReusableEnvironment(options);
  if (existing) return existing;

  const directory = virtualEnvironmentDirectory(options.projectRoot);
  const check = async (): Promise<PythonInfo | null> => {
    const candidate = await inspectVirtualEnvironment(directory, options);
    return candidate && pythonSatisfiesPolicy(candidate, options) &&
      await virtualEnvironmentMatchesConfiguredPython(candidate, options)
      ? candidate
      : null;
  };
  if (!options.createVirtualEnvironment) {
    throw new Error(
      `No compatible environment is available and creation is disabled. ` +
      `Pyfig would create ${directory}.`,
    );
  }

  const basePython = await ensureBasePythonResolved(uv, options);
  return withProvisioningLock({
    key: `venv:${canonicalPath(directory)}`,
    timeoutMs: options.coordinationTimeoutMs,
    check,
    mutate: async () => {
      // Only Pyfig's private path is replaceable. Active and repository-root
      // environments are preserved when incompatible.
      await rm(directory, { recursive: true, force: true });
      await mkdir(path.dirname(directory), { recursive: true });
      await runAsync(
        uv.executable,
        [
          'venv',
          '--no-project',
          '--no-config',
          '--no-python-downloads',
          '--python',
          basePython.executable,
          directory,
        ],
        isolatedUvEnvironment(options),
        options.installTimeoutMs,
      );
      const installed = await check();
      if (!installed) {
        throw new Error(
          `uv created ${directory}, but its Python does not satisfy the requested capabilities.`,
        );
      }
      return installed;
    },
  });
}

async function findReusableEnvironment(
  options: ResolvedPyfigOptions,
): Promise<PythonInfo | null> {
  if (options.python) {
    const configured = await probePython({ executable: options.python, args: [] }, options);
    if (!configured || !pythonSatisfiesPolicy(configured, options)) {
      throw incompatibleConfiguredPython(options);
    }
    if (configured.virtualEnvironment) return configured;
  }

  for (const directory of [
    ...externalVirtualEnvironmentDirectories(options.projectRoot, options.env),
    virtualEnvironmentDirectory(options.projectRoot),
  ]) {
    const info = await inspectVirtualEnvironment(directory, options);
    if (info && pythonSatisfiesPolicy(info, options) &&
        await virtualEnvironmentMatchesConfiguredPython(info, options)) {
      return info;
    }
  }
  return null;
}

async function ensureBasePythonResolved(
  uv: UvInfo,
  options: ResolvedPyfigOptions,
): Promise<PythonInfo> {
  if (options.python) {
    const configured = await probePython({ executable: options.python, args: [] }, options);
    if (!configured || !pythonSatisfiesPolicy(configured, options)) {
      throw incompatibleConfiguredPython(options);
    }
    if (!configured.virtualEnvironment) return configured;
    const base = await probePython({ executable: configured.baseExecutable, args: [] }, options);
    if (base && pythonSatisfiesPolicy(base, options)) return base;
    throw incompatibleConfiguredPython(options);
  }

  // Corporate and offline hosts get a strict system-only pass before Pyfig
  // considers any already-managed interpreter or network installation.
  const system = await findPythonWithUv(uv, options, 'system');
  if (system) return system;
  const cachedManaged = await findPythonWithUv(uv, options, 'managed');
  if (cachedManaged) return cachedManaged;
  if (!options.installPython) {
    throw new Error(missingPythonMessage(options, 'managed Python installation is disabled'));
  }

  return withProvisioningLock({
    key: `python:${canonicalPath(path.join(options.cacheDir, 'python'))}`,
    timeoutMs: options.coordinationTimeoutMs,
    check: () => findPythonWithUv(uv, options, 'managed'),
    mutate: async () => {
      await runAsync(
        uv.executable,
        ['python', 'install', '--no-config', options.managedPython],
        isolatedUvEnvironment(options),
        options.installTimeoutMs,
      );
      const installed = await findPythonWithUv(uv, options, 'managed');
      if (!installed) {
        throw new Error(missingPythonMessage(
          options,
          `uv installed ${options.managedPython}, but it remains incompatible`,
        ));
      }
      return installed;
    },
  });
}

async function findPythonWithUv(
  uv: UvInfo,
  options: ResolvedPyfigOptions,
  source: 'system' | 'managed',
): Promise<PythonInfo | null> {
  for (const request of ['', options.managedPython]) {
    const args = [
      'python',
      'find',
      '--no-project',
      '--no-config',
      '--no-python-downloads',
      source === 'system' ? '--system' : '--managed-python',
    ];
    if (request) args.push(request);
    try {
      const { stdout } = await runAsync(
        uv.executable,
        args,
        explicitPythonSourceEnvironment(options),
        options.probeTimeoutMs,
      );
      const info = await probePython({ executable: stdout.trim(), args: [] }, options);
      if (info && pythonSatisfiesPolicy(info, options)) return info;
    } catch {
      // Continue through the generic and configured version requests.
    }
  }

  // `uv python find` returns one match. That match can lack development
  // headers even when another installed interpreter satisfies every requested
  // capability, so inspect uv's complete installed-only inventory before
  // moving from system Python to managed Python or from cache to download.
  try {
    const { stdout } = await runAsync(
      uv.executable,
      [
        'python',
        'list',
        '--no-config',
        '--no-python-downloads',
        '--only-installed',
        '--output-format',
        'json',
        source === 'system' ? '--no-managed-python' : '--managed-python',
      ],
      explicitPythonSourceEnvironment(options),
      options.probeTimeoutMs,
    );
    const candidates = installedPythonPaths(stdout);
    for (const executable of candidates) {
      const info = await probePython({ executable, args: [] }, options);
      if (info && !info.virtualEnvironment && pythonSatisfiesPolicy(info, options)) {
        return info;
      }
    }
  } catch {
    // Older compatible uv releases can still use the find-based fallback.
  }
  return null;
}

function installedPythonPaths(output: string): string[] {
  const parsed = JSON.parse(output) as unknown;
  if (!Array.isArray(parsed)) return [];
  const paths = parsed.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || !('path' in entry)) return [];
    const candidate = (entry as { path?: unknown }).path;
    return typeof candidate === 'string' && candidate ? [candidate] : [];
  });
  return [...new Map(paths.map((candidate) => [canonicalPath(candidate), candidate])).values()];
}

async function inspectVirtualEnvironment(
  directory: string,
  options: ResolvedPyfigOptions,
): Promise<PythonInfo | null> {
  const executable = virtualEnvironmentPythonExecutable(directory);
  const info = await probePython({ executable, args: [] }, options);
  return info?.virtualEnvironment && pathsEqual(info.virtualEnvironment, directory) ? info : null;
}

async function installRuntimeDependencies(
  uv: UvInfo,
  python: PythonInfo,
  dependencies: readonly string[],
  dependencyOptions: Required<RuntimeDependencyOptions>,
  options: ResolvedPyfigOptions,
): Promise<void> {
  if (!python.virtualEnvironment) {
    throw new Error('Runtime dependency installation requires a virtual environment.');
  }
  await withProvisioningLock({
    key: `dependencies:${canonicalPath(python.virtualEnvironment)}`,
    timeoutMs: options.coordinationTimeoutMs,
    check: async () => null,
    mutate: async () => {
      const temporary = await mkdtemp(path.join(os.tmpdir(), 'pyfig-dependencies-'));
      try {
        const additions = path.join(temporary, 'runtime-dependencies.txt');
        const resolved = path.join(temporary, 'resolved-dependencies.txt');
        const pyproject = path.join(options.projectRoot, 'pyproject.toml');
        const hasPyproject = fs.existsSync(pyproject);
        if (!hasPyproject && (
          dependencyOptions.extras.length > 0 ||
          dependencyOptions.groups.length > 0 ||
          dependencyOptions.allExtras
        )) {
          throw new Error('Runtime extras and groups require an existing pyproject.toml.');
        }
        const sources = hasPyproject ? [pyproject] : [];
        if (dependencies.length > 0) {
          await writeFile(additions, `${dependencies.join('\n')}\n`, 'utf8');
          sources.push(additions);
        }
        const selectionArgs = [
          ...dependencyOptions.extras.flatMap((extra) => ['--extra', extra]),
          ...dependencyOptions.groups.flatMap((group) => ['--group', group]),
          ...(dependencyOptions.allExtras ? ['--all-extras'] : []),
        ];
        await runAsync(
          uv.executable,
          [
            'pip', 'compile', '--no-config', '--python', python.executable, ...selectionArgs,
            ...sources, '--output-file', resolved,
          ],
          targetUvEnvironment(options, python),
          options.installTimeoutMs,
          undefined,
          options.projectRoot,
        );
        // install preserves unrelated packages; sync would remove anything not
        // represented in this temporary resolution.
        await runAsync(
          uv.executable,
          ['pip', 'install', '--no-config', '--python', python.executable, '-r', resolved],
          targetUvEnvironment(options, python),
          options.installTimeoutMs,
          undefined,
          options.projectRoot,
        );
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
      return true;
    },
  });
}

async function ensureUvResolved(options: ResolvedPyfigOptions): Promise<UvInfo> {
  const existing = await findAvailableUv(options);
  if (existing) return existing;
  if (!options.installUv) {
    throw new Error(
      `Compatible uv is unavailable (requires-uv ${options.requiresUv}), and uv installation is disabled.`,
    );
  }

  const policyKey = createHash('sha256').update(options.requiresUv).digest('hex');
  return withProvisioningLock({
    key: `uv-policy:${canonicalPath(uvInstallRoot(options))}:${policyKey}`,
    timeoutMs: options.coordinationTimeoutMs,
    check: () => findAvailableUv(options),
    mutate: async () => {
      const release = await resolveUvRelease(options);
      const installDir = uvInstallDirectory(options, release.version);
      const executable = uvExecutable(options, release.version);
      return withProvisioningLock({
        key: `uv-release:${canonicalPath(installDir)}`,
        timeoutMs: options.coordinationTimeoutMs,
        check: () => findAvailableUv(options),
        mutate: async () => {
          await installUv(installDir, release, options);
          const result = probeUv(executable, options);
          if (!result || result.version !== release.version) {
            throw new Error(
              `Expected managed uv ${release.version}, but the installed executable did not match.`,
            );
          }
          return result;
        },
      });
    },
  });
}

async function findAvailableUv(options: ResolvedPyfigOptions): Promise<UvInfo | null> {
  const external = await findUv(options);
  if (external) return external;
  return findManagedUv(options);
}

async function findManagedUv(options: ResolvedPyfigOptions): Promise<UvInfo | null> {
  const entries = await readdir(uvInstallRoot(options), { withFileTypes: true }).catch(() => []);
  let versions = entries
    .filter(entry => entry.isDirectory() && normalizePep440Version(entry.name) === entry.name)
    .map(entry => entry.name);
  while (versions.length > 0) {
    const selected = maxPep440Version(versions, options.requiresUv);
    if (!selected) return null;
    const candidate = probeUv(uvExecutable(options, selected), options);
    if (candidate?.version === selected) return candidate;
    versions = versions.filter(version => version !== selected);
  }
  return null;
}

function normalizeDependencies(dependencies: readonly string[]): string[] {
  const normalized = dependencies.map((dependency) => dependency.trim());
  for (const dependency of normalized) {
    if (!dependency || /[\0\r\n]/u.test(dependency)) {
      throw new TypeError(`Invalid runtime dependency: ${JSON.stringify(dependency)}`);
    }
  }
  return [...new Set(normalized)];
}

function normalizeDependencyOptions(
  options: RuntimeDependencyOptions,
): Required<RuntimeDependencyOptions> {
  const extras = normalizeNames('extra', options.extras ?? []);
  const groups = normalizeNames('dependency group', options.groups ?? []);
  if (options.allExtras && extras.length > 0) {
    throw new TypeError('allExtras cannot be combined with explicit extras.');
  }
  return { extras, groups, allExtras: options.allExtras ?? false };
}

function normalizeNames(kind: string, names: readonly string[]): string[] {
  const normalized = names.map((name) => name.trim());
  for (const name of normalized) {
    if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name)) {
      throw new TypeError(`Invalid ${kind}: ${JSON.stringify(name)}`);
    }
  }
  return [...new Set(normalized)];
}

function isManagedEnvironment(
  python: PythonInfo,
  options: ResolvedPyfigOptions,
): boolean {
  return Boolean(python.virtualEnvironment) && pathsEqual(
    python.virtualEnvironment as string,
    virtualEnvironmentDirectory(options.projectRoot),
  );
}

function isolatedUvEnvironment(options: ResolvedPyfigOptions): NodeJS.ProcessEnv {
  return sanitizeUvEnvironment(uvEnvironment(options));
}

/** Explicit --system/--managed-python selectors cannot be combined with uv's preference setting. */
function explicitPythonSourceEnvironment(
  options: ResolvedPyfigOptions,
): NodeJS.ProcessEnv {
  const env = isolatedUvEnvironment(options);
  delete env['UV_PYTHON_PREFERENCE'];
  return env;
}

function targetUvEnvironment(
  options: ResolvedPyfigOptions,
  python: PythonInfo,
): NodeJS.ProcessEnv {
  return uvCommandEnvironment(uvEnvironment(options), python);
}

function incompatibleConfiguredPython(options: ResolvedPyfigOptions): Error {
  return new Error(
    `Configured Python ${options.python} is unavailable or does not satisfy ` +
    `requires-python ${options.requiresPython}` +
    `${options.requireEmbedding ? ' with CPython embedding files' : ''}.`,
  );
}

function missingPythonMessage(options: ResolvedPyfigOptions, reason: string): string {
  const embedding = options.requireEmbedding
    ? ' with compatible CPython headers, library, architecture, and GIL ABI'
    : '';
  return `No Python satisfies requires-python ${options.requiresPython}${embedding}; ${reason}.`;
}

async function virtualEnvironmentMatchesConfiguredPython(
  virtualEnvironment: PythonInfo,
  options: ResolvedPyfigOptions,
): Promise<boolean> {
  if (!options.python) return true;
  const configured = await probePython({ executable: options.python, args: [] }, options);
  if (!configured || !pythonSatisfiesPolicy(configured, options)) return false;
  if (configured.virtualEnvironment && pathsEqual(configured.executable, virtualEnvironment.executable)) {
    return true;
  }
  const configuredBase = configured.virtualEnvironment
    ? configured.baseExecutable
    : configured.executable;
  return pathsEqual(configuredBase, virtualEnvironment.baseExecutable);
}

interface UvRelease {
  tag: string;
  version: string;
}

const UV_RELEASE_PAGE_SIZE = 100;
const UV_RELEASE_MAX_PAGES = 20;

async function resolveUvRelease(options: ResolvedPyfigOptions): Promise<UvRelease> {
  const dispatcher = proxyDispatcher(options.env);
  const releases = new Map<string, string>();
  const asset = uvAsset();
  let exhausted = false;
  try {
    for (let page = 1; page <= UV_RELEASE_MAX_PAGES; page += 1) {
      const text = await downloadText(
        `https://api.github.com/repos/astral-sh/uv/releases?per_page=${UV_RELEASE_PAGE_SIZE}&page=${page}`,
        options.downloadTimeoutMs,
        dispatcher,
        {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'pyfig',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      );
      const payload = JSON.parse(text) as unknown;
      if (!Array.isArray(payload)) {
        throw new Error('GitHub returned invalid uv release metadata.');
      }
      for (const candidate of payload) {
        if (!candidate || typeof candidate !== 'object') continue;
        const release = candidate as { assets?: unknown; draft?: unknown; tag_name?: unknown };
        if (release.draft === true || typeof release.tag_name !== 'string') continue;
        const assetNames = releaseAssetNames(release.assets);
        if (!assetNames.includes(asset) || !assetNames.includes(`${asset}.sha256`)) continue;
        const version = normalizePep440Version(release.tag_name);
        if (version) releases.set(version, release.tag_name);
      }
      if (payload.length < UV_RELEASE_PAGE_SIZE) {
        exhausted = true;
        break;
      }
    }
  } finally {
    await dispatcher?.close();
  }

  if (!exhausted) {
    throw new Error(`uv release catalog exceeded ${UV_RELEASE_MAX_PAGES} pages.`);
  }
  const version = maxPep440Version([...releases.keys()], options.requiresUv);
  const tag = version ? releases.get(version) : undefined;
  if (!version || !tag) {
    throw new Error(`No published uv release satisfies requires-uv ${options.requiresUv}.`);
  }
  return { tag, version };
}

function releaseAssetNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(entry => {
    if (!entry || typeof entry !== 'object') return [];
    const name = (entry as { name?: unknown }).name;
    return typeof name === 'string' ? [name] : [];
  });
}

function uvInstallRoot(options: ResolvedPyfigOptions): string {
  return path.join(options.cacheDir, 'tools', 'uv');
}

function uvInstallDirectory(options: ResolvedPyfigOptions, version: string): string {
  return path.join(uvInstallRoot(options), version);
}

function uvExecutable(options: ResolvedPyfigOptions, version: string): string {
  return path.join(
    uvInstallDirectory(options, version),
    process.platform === 'win32' ? 'uv.exe' : 'uv',
  );
}

async function installUv(
  installDir: string,
  release: UvRelease,
  options: ResolvedPyfigOptions,
): Promise<void> {
  const asset = uvAsset();
  const baseUrl = `https://github.com/astral-sh/uv/releases/download/${release.tag}`;
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'pyfig-uv-'));
  const dispatcher = proxyDispatcher(options.env);
  try {
    const archive = path.join(temporary, asset);
    await download(`${baseUrl}/${asset}`, archive, options.downloadTimeoutMs, dispatcher);
    const expected = (await downloadText(
      `${baseUrl}/${asset}.sha256`,
      options.downloadTimeoutMs,
      dispatcher,
    )).trim().split(/\s+/u)[0];
    const actual = await sha256File(archive);
    if (!expected || expected.toLowerCase() !== actual.toLowerCase()) {
      throw new Error(`uv archive checksum mismatch for ${asset}`);
    }

    const extracted = path.join(temporary, 'extracted');
    await mkdir(extracted, { recursive: true });
    const source = await extractUvExecutable(archive, asset, extracted);
    if (!source) throw new Error(`uv archive did not contain the expected executable: ${asset}`);
    await publishUvAtomically(source, installDir, release.version, options);
  } finally {
    await dispatcher?.close();
    await rm(temporary, { recursive: true, force: true });
  }
}

async function extractUvExecutable(
  archive: string,
  asset: string,
  destination: string,
): Promise<string | null> {
  const executableName = process.platform === 'win32' ? 'uv.exe' : 'uv';
  if (!asset.endsWith('.zip')) {
    await tar.x({ file: archive, cwd: destination, strict: true });
    return findFile(destination, executableName);
  }

  // ZIP entry paths are never written to disk. Extract only uv's bytes and
  // publish them at a path controlled by Pyfig, which prevents Zip Slip and
  // symlink entries from redirecting writes outside the temporary directory.
  const entries = unzipSync(await readFile(archive), {
    filter: ({ name }) => path.posix.basename(name.replaceAll('\\', '/')) === executableName,
  });
  const matches = Object.entries(entries)
    .filter(([name]) => path.posix.basename(name.replaceAll('\\', '/')) === executableName);
  if (matches.length !== 1 || !matches[0]) return null;
  const source = path.join(destination, executableName);
  await writeFile(source, matches[0][1], { flag: 'wx' });
  return source;
}

async function publishUvAtomically(
  source: string,
  installDir: string,
  version: string,
  options: ResolvedPyfigOptions,
): Promise<void> {
  await mkdir(installDir, { recursive: true });
  const executable = uvExecutable(options, version);
  const staged = path.join(
    installDir,
    `.${path.basename(executable)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await copyFile(source, staged);
    if (process.platform !== 'win32') await chmod(staged, 0o755);
    const stagedUv = probeUv(staged, options);
    if (!stagedUv || stagedUv.version !== version) {
      throw new Error(`Downloaded uv executable is not version ${version}.`);
    }
    if (process.platform === 'win32') await rm(executable, { force: true });
    await rename(staged, executable);
  } finally {
    await rm(staged, { force: true });
  }
}

function uvAsset(): string {
  const architecture = process.arch === 'x64'
    ? 'x86_64'
    : process.arch === 'arm64'
      ? 'aarch64'
      : null;
  if (!architecture) throw new Error(`uv bootstrap does not support architecture ${process.arch}.`);
  if (process.platform === 'win32') return `uv-${architecture}-pc-windows-msvc.zip`;
  if (process.platform === 'darwin') return `uv-${architecture}-apple-darwin.tar.gz`;
  if (process.platform === 'linux') return `uv-${architecture}-unknown-linux-musl.tar.gz`;
  throw new Error(`uv bootstrap does not support platform ${process.platform}.`);
}

async function download(
  url: string,
  destination: string,
  timeoutMs: number,
  dispatcher: EnvHttpProxyAgent | undefined,
): Promise<void> {
  const response = await fetch(url, {
    dispatcher,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Could not download ${url}: HTTP ${response.status}`);
  }
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(destination, { flags: 'wx' }),
  );
}

async function downloadText(
  url: string,
  timeoutMs: number,
  dispatcher: EnvHttpProxyAgent | undefined,
  headers?: Record<string, string>,
): Promise<string> {
  const response = await fetch(url, {
    dispatcher,
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Could not download ${url}: HTTP ${response.status}`);
  }
  return response.text();
}

function proxyDispatcher(env: NodeJS.ProcessEnv): EnvHttpProxyAgent | undefined {
  const httpProxy = environmentValue(env, 'http_proxy', 'HTTP_PROXY');
  const httpsProxy = environmentValue(env, 'https_proxy', 'HTTPS_PROXY');
  if (!httpProxy && !httpsProxy) return undefined;
  return new EnvHttpProxyAgent({
    httpProxy,
    httpsProxy,
    noProxy: environmentValue(env, 'no_proxy', 'NO_PROXY'),
  });
}

function environmentValue(
  env: NodeJS.ProcessEnv,
  lowercase: string,
  uppercase: string,
): string | undefined {
  return env[lowercase] ?? env[uppercase];
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function findFile(directory: string, name: string): Promise<string | null> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === name) return target;
    if (entry.isDirectory()) {
      const nested = await findFile(target, name);
      if (nested) return nested;
    }
  }
  return null;
}
