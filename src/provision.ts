import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import extractZip from 'extract-zip';
import * as tar from 'tar';
import { EnvHttpProxyAgent, fetch } from 'undici';
import {
  resolveOptions,
  uvEnvironment,
  type PyfigOptions,
  type ResolvedPyfigOptions,
} from './config.js';
import { withProvisioningLock } from './provision-lock.js';
import {
  findPip,
  findPython,
  findUv,
  probePython,
  probeUv,
  pythonSatisfiesRequirements,
  type PackageManagerInfo,
  type PythonInfo,
  type UvInfo,
} from './probes.js';
import { runAsync } from './process.js';
import {
  canonicalPath,
  pathsEqual,
  virtualEnvironmentDirectory,
  virtualEnvironmentPythonExecutable,
} from './virtual-environment.js';

export interface PythonEnvironment {
  python: PythonInfo;
  packageManager: PackageManagerInfo;
}

export async function ensurePython(options: PyfigOptions = {}): Promise<PythonInfo> {
  const resolved = resolveOptions(options);
  return ensurePythonResolved(resolved);
}

export async function ensurePip(
  options: PyfigOptions = {},
  python?: PythonInfo,
): Promise<PackageManagerInfo> {
  const resolved = resolveOptions(options);
  const selectedPython = python?.virtualEnvironment
    ? python
    : await ensureVirtualEnvironmentResolved(resolved);
  return ensurePipResolved(selectedPython, resolved);
}

export async function ensureVirtualEnvironment(options: PyfigOptions = {}): Promise<PythonInfo> {
  const resolved = resolveOptions(options);
  return ensureVirtualEnvironmentResolved(resolved);
}

export async function ensureUv(options: PyfigOptions = {}): Promise<UvInfo> {
  const resolved = resolveOptions(options);
  return ensureUvResolved(resolved);
}

export async function ensureEnvironment(options: PyfigOptions = {}): Promise<PythonEnvironment> {
  const resolved = resolveOptions(options);
  const python = await ensureVirtualEnvironmentResolved(resolved);
  const packageManager = await ensurePipResolved(python, resolved);
  return { python, packageManager };
}

async function ensureVirtualEnvironmentResolved(
  options: ResolvedPyfigOptions,
): Promise<PythonInfo> {
  const directory = virtualEnvironmentDirectory(options.projectRoot);
  const check = async (): Promise<PythonInfo | null> => {
    const existing = await inspectVirtualEnvironment(directory, options);
    if (!existing) return null;
    if (pythonSatisfiesRequirements(existing, options) &&
        await virtualEnvironmentMatchesConfiguredPython(existing, options)) {
      return existing;
    }
    throw incompatibleVirtualEnvironmentError(directory, existing, options);
  };

  const existing = await check();
  if (existing) return existing;
  if (!options.createVirtualEnvironment) {
    throw new Error(
      `No virtual environment at ${directory} satisfies the Python requirements; ` +
      'virtual-environment creation is disabled.',
    );
  }

  // Base discovery happens before taking the venv lock, keeping the global lock
  // order Python -> uv -> venv consistent across callers.
  const basePython = await ensurePythonResolved(options);
  const preferredUv = await findAvailableUv(options) ??
    (options.installUv ? await ensureUvResolved(options) : null);
  return withProvisioningLock({
    key: `venv:${canonicalPath(directory)}`,
    timeoutMs: options.coordinationTimeoutMs,
    check,
    mutate: async () => {
      await mkdir(directory, { recursive: true });
      const entries = await readdir(directory);
      const hasVenvConfiguration = fs.existsSync(path.join(directory, 'pyvenv.cfg'));
      if (entries.length > 0 && !hasVenvConfiguration) {
        throw new Error(`Refusing to replace non-virtual-environment contents at ${directory}.`);
      }

      await createVirtualEnvironment(directory, basePython, preferredUv, options);
      const installed = await inspectVirtualEnvironment(directory, options);
      if (!installed || !pythonSatisfiesRequirements(installed, options)) {
        throw new Error(
          `Python created ${directory}, but it does not satisfy the requested runtime capabilities.`,
        );
      }
      return installed;
    },
  });
}

async function createVirtualEnvironment(
  directory: string,
  basePython: PythonInfo,
  preferredUv: UvInfo | null,
  options: ResolvedPyfigOptions,
): Promise<void> {
  if (preferredUv) {
    try {
      await createVirtualEnvironmentWithUv(preferredUv, directory, basePython, options);
      return;
    } catch {
      // A usable Python may still provide its standard-library venv module.
    }
  }

  try {
    await runAsync(
      basePython.executable,
      ['-m', 'venv', directory],
      withoutActiveVirtualEnvironment(options.env),
      options.installTimeoutMs,
    );
    return;
  } catch (systemVenvError) {
    if (preferredUv || !options.installUv) throw systemVenvError;
  }
  throw new Error('Python could not create a virtual environment and uv installation is disabled.');
}

async function createVirtualEnvironmentWithUv(
  uv: UvInfo,
  directory: string,
  basePython: PythonInfo,
  options: ResolvedPyfigOptions,
): Promise<void> {
  await runAsync(
    uv.executable,
    [
      'venv',
      '--no-project',
      '--no-config',
      '--no-python-downloads',
      '--allow-existing',
      '--python',
      basePython.executable,
      directory,
    ],
    uvEnvironment(options),
    options.installTimeoutMs,
  );
}

async function inspectVirtualEnvironment(
  directory: string,
  options: ResolvedPyfigOptions,
): Promise<PythonInfo | null> {
  const executable = virtualEnvironmentPythonExecutable(directory);
  const info = await probePython({ executable, args: [] }, options);
  return info?.virtualEnvironment && pathsEqual(info.virtualEnvironment, directory) ? info : null;
}

async function ensurePythonResolved(options: ResolvedPyfigOptions): Promise<PythonInfo> {
  const existing = await discoverPython(options);
  if (existing) return existing;
  if (!options.installPython) {
    const capability = options.requireEmbedding
      ? ' with compatible CPython development headers, architecture, and a linkable library'
      : '';
    throw new Error(
      `No Python interpreter satisfies ${options.pythonRange}${capability}; ` +
      'managed Python installation is disabled.',
    );
  }

  return withProvisioningLock({
    key: `python:${canonicalPath(path.join(options.cacheDir, 'python'))}`,
    timeoutMs: options.coordinationTimeoutMs,
    check: () => discoverPython(options),
    mutate: async () => {
      const uv = await ensureUvResolved(options);
      const uvEnv = uvEnvironment(options);
      await runAsync(
        uv.executable,
        ['python', 'install', '--no-config', options.managedPython],
        uvEnv,
        options.installTimeoutMs,
      );
      const installed = await findPythonWithUv(uv, options);
      if (!installed) {
        throw new Error(
          `uv installed Python ${options.managedPython}, but it does not satisfy the requested ` +
          'runtime capabilities.',
        );
      }
      return installed;
    },
  });
}

async function discoverPython(options: ResolvedPyfigOptions): Promise<PythonInfo | null> {
  if (options.python) {
    const configured = await probePython({ executable: options.python, args: [] }, options);
    if (configured && pythonSatisfiesRequirements(configured, options)) return configured;
    throw new Error(
      `Configured Python ${options.python} is unavailable or does not satisfy ${options.pythonRange}.`,
    );
  }

  const existingUv = await findAvailableUv(options);
  if (existingUv) {
    const uvPython = await findPythonWithUv(existingUv, options);
    if (uvPython) return uvPython;
  }
  return findPython({ ...options, python: '' });
}

async function findPythonWithUv(
  uv: UvInfo,
  options: ResolvedPyfigOptions,
): Promise<PythonInfo | null> {
  const requests = [undefined, options.managedPython] as const;
  for (const requestedPython of requests) {
    const args = [
      'python',
      'find',
      '--no-project',
      '--no-config',
      '--managed-python',
      '--no-python-downloads',
    ];
    if (requestedPython) args.push(requestedPython);
    try {
      const { stdout } = await runAsync(
        uv.executable,
        args,
        uvEnvironment(options),
        options.probeTimeoutMs,
      );
      const info = await probePython({ executable: stdout.trim(), args: [] }, options);
      if (info && pythonSatisfiesRequirements(info, options)) return info;
    } catch {
      // Continue through the configured request and then normal system discovery.
    }
  }
  return null;
}

async function ensurePipResolved(
  python: PythonInfo,
  options: ResolvedPyfigOptions,
): Promise<PackageManagerInfo> {
  const existingUv = await findAvailableUv(options);
  if (existingUv) return uvPackageManager(existingUv, python);

  // Default package operations always use uv, which supplies its own robust
  // target-venv lock. python -m pip remains a read-only fallback for check-only setups.
  if (options.installUv) return uvPackageManager(await ensureUvResolved(options), python);

  const existingPip = await findPip(python, options);
  if (existingPip) return existingPip;
  throw new Error(
    `The virtual environment's python -m pip does not satisfy ${options.pipRange}; ` +
    'uv installation is disabled.',
  );
}

async function ensureUvResolved(options: ResolvedPyfigOptions): Promise<UvInfo> {
  const existing = await findAvailableUv(options);
  if (existing) return existing;
  if (!options.installUv) {
    throw new Error(
      `Compatible uv is unavailable (required ${options.uvRange}), and uv installation is disabled.`,
    );
  }

  const installDir = uvInstallDirectory(options);
  const executable = uvExecutable(options);
  return withProvisioningLock({
    key: `uv:${canonicalPath(installDir)}`,
    timeoutMs: options.coordinationTimeoutMs,
    check: () => findAvailableUv(options),
    mutate: async () => {
      await installUv(installDir, options);
      const result = probeUv(executable, options);
      if (!result || result.version !== options.uvVersion) {
        throw new Error(
          `Expected managed uv ${options.uvVersion}, but the installed executable did not match.`,
        );
      }
      return result;
    },
  });
}

async function findAvailableUv(options: ResolvedPyfigOptions): Promise<UvInfo | null> {
  // Prefer a configured or PATH uv that passes the compatibility probe. The
  // managed cache is a fallback, even when its pinned version is newer.
  const external = await findUv(options);
  if (external) return external;
  const managed = probeUv(uvExecutable(options), options);
  return managed?.version === options.uvVersion ? managed : null;
}

function uvInstallDirectory(options: ResolvedPyfigOptions): string {
  return path.join(options.cacheDir, 'tools', 'uv', options.uvVersion);
}

function uvExecutable(options: ResolvedPyfigOptions): string {
  return path.join(
    uvInstallDirectory(options),
    process.platform === 'win32' ? 'uv.exe' : 'uv',
  );
}

function uvPackageManager(uv: UvInfo, python: PythonInfo): PackageManagerInfo {
  if (!python.virtualEnvironment) {
    throw new Error('uv pip commands require a virtual-environment Python interpreter.');
  }
  return {
    kind: 'uv',
    executable: uv.executable,
    prefixArgs: ['pip'],
    version: uv.version,
    pythonExecutable: python.executable,
    virtualEnvironment: python.virtualEnvironment,
  };
}

function withoutActiveVirtualEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...env };
  for (const key of Object.keys(result)) {
    const normalized = key.toUpperCase();
    if (normalized === 'CONDA_PREFIX' || normalized === 'VIRTUAL_ENV' ||
        normalized === 'PYTHONHOME') {
      delete result[key];
    }
  }
  return result;
}

async function installUv(
  installDir: string,
  options: ResolvedPyfigOptions,
): Promise<void> {
  const asset = uvAsset();
  const baseUrl = `https://github.com/astral-sh/uv/releases/download/${options.uvVersion}`;
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'pyfig-uv-'));
  const dispatcher = proxyDispatcher(options.env);
  try {
    const archive = path.join(temporary, asset);
    await download(
      `${baseUrl}/${asset}`,
      archive,
      options.downloadTimeoutMs,
      dispatcher,
    );
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
    if (asset.endsWith('.zip')) await extractZip(archive, { dir: extracted });
    else await tar.x({ file: archive, cwd: extracted, strict: true });

    const source = await findFile(extracted, process.platform === 'win32' ? 'uv.exe' : 'uv');
    if (!source) throw new Error(`uv archive did not contain the expected executable: ${asset}`);
    await publishUvAtomically(source, installDir, options);
  } finally {
    await dispatcher?.close();
    await rm(temporary, { recursive: true, force: true });
  }
}

async function publishUvAtomically(
  source: string,
  installDir: string,
  options: ResolvedPyfigOptions,
): Promise<void> {
  await mkdir(installDir, { recursive: true });
  const executable = uvExecutable(options);
  const staged = path.join(
    installDir,
    `.${path.basename(executable)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await copyFile(source, staged);
    if (process.platform !== 'win32') await chmod(staged, 0o755);
    const stagedUv = probeUv(staged, options);
    if (!stagedUv || stagedUv.version !== options.uvVersion) {
      throw new Error(`Downloaded uv executable is not version ${options.uvVersion}.`);
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
  // Astral's musl artifacts are fully static and run on both musl and glibc Linux.
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
): Promise<string> {
  const response = await fetch(url, {
    dispatcher,
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

function incompatibleVirtualEnvironmentError(
  directory: string,
  python: PythonInfo,
  options: ResolvedPyfigOptions,
): Error {
  const capabilities = options.requireEmbedding
    ? ' or lacks compatible CPython embedding headers, library, or architecture'
    : '';
  return new Error(
    `The existing virtual environment at ${directory} uses Python ${python.version}, ` +
    `which does not satisfy ${options.pythonRange}${capabilities}.`,
  );
}

async function virtualEnvironmentMatchesConfiguredPython(
  virtualEnvironment: PythonInfo,
  options: ResolvedPyfigOptions,
): Promise<boolean> {
  if (!options.python) return true;
  const configured = await probePython({ executable: options.python, args: [] }, options);
  if (!configured || !pythonSatisfiesRequirements(configured, options)) return false;
  if (configured.virtualEnvironment && pathsEqual(configured.executable, virtualEnvironment.executable)) {
    return true;
  }
  const configuredBase = configured.virtualEnvironment
    ? configured.baseExecutable
    : configured.executable;
  return pathsEqual(configuredBase, virtualEnvironment.baseExecutable);
}
