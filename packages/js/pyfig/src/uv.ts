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
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  maxSatisfying,
  valid as validVersion,
} from '@renovatebot/pep440';
import { unzipSync } from 'fflate';
import { withLock } from 'loqkit';
import * as tar from 'tar';
import { EnvHttpProxyAgent, fetch } from 'undici';
import { z } from 'zod';
import type { DebugLogger } from './logging.js';
import type { UvMetadata, UvSource } from './pyfig.js';
import {
  capture,
  environmentValue,
  findExecutables,
} from './process.js';

const archiveFormatSchema = z.enum(['tar.gz', 'zip']);
const sha256Schema = z.string().regex(/^[a-f\d]{64}$/iu).transform(value => value.toLowerCase());
const httpsUrlSchema = z.url().refine(value => value.startsWith('https://'));
const uvVersionSchema = z.string().refine(value => validVersion(value) === value);
const uvArtifactSchema = z.object({
  archiveFormat: archiveFormatSchema,
  platform: z.string().min(1),
  sha256: sha256Schema,
  url: httpsUrlSchema,
}).readonly();
const uvReleaseSchema = z.object({
  artifact: uvArtifactSchema,
  version: uvVersionSchema,
}).readonly();
const uvReleaseCatalogSchema = z.object({
  fetchedAt: z.number().int().nonnegative(),
  releases: z.array(uvReleaseSchema).readonly(),
}).readonly();
const uvManifestArtifactSchema = z.object({
  archive_format: archiveFormatSchema,
  platform: z.string().min(1),
  sha256: sha256Schema,
  url: httpsUrlSchema,
  variant: z.literal('default').optional(),
}).transform(artifact => uvArtifactSchema.parse({
  archiveFormat: artifact.archive_format,
  platform: artifact.platform,
  sha256: artifact.sha256,
  url: artifact.url,
}));

type UvArtifact = z.output<typeof uvArtifactSchema>;
type UvRelease = z.output<typeof uvReleaseSchema>;
type UvReleaseCatalog = z.output<typeof uvReleaseCatalogSchema>;

interface UvSetupContext {
  cache: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  log: DebugLogger;
  specifier: string;
}

type ResolvedUv = Omit<UvMetadata, 'source'> & {
  readonly source: Exclude<UvSource, 'explicit'>;
};

const RELEASE_METADATA_TTL_MS = 24 * 60 * 60_000;
const METADATA_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const COORDINATION_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_ASTRAL_RELEASES = 'https://releases.astral.sh';
const DEFAULT_RAW_GITHUB = 'https://raw.githubusercontent.com';

/** Prefer compatible PATH and cached binaries before provisioning official uv. */
export async function resolveUv(
  specifier: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  log: DebugLogger,
): Promise<ResolvedUv> {
  const context: UvSetupContext = {
    cache: uvCacheDirectory(env),
    cwd,
    env,
    log,
    specifier,
  };
  log('Searching for an available uv.', { cache: context.cache, specifier });
  const existing = await findAvailableUv(context);
  if (existing) {
    log('Found an available uv.', existing);
    return existing;
  }

  const policy = createHash('sha256').update(specifier).digest('hex');
  return withProvisioningLock<ResolvedUv>({
    key: `uv-policy:${canonicalPath(context.cache)}:${policy}`,
    log,
    check: () => findAvailableUv(context),
    mutate: async () => {
      const release = await resolveUvRelease(context);
      const destination = uvInstallDirectory(context, release.version);
      const installed = await withProvisioningLock({
        key: `uv-release:${canonicalPath(destination)}`,
        log,
        check: () => probeUv(uvExecutable(context, release.version), context, release.version),
        mutate: async () => {
          await installUv(release, context);
          const executable = await probeUv(
            uvExecutable(context, release.version),
            context,
            release.version,
          );
          if (!executable) {
            throw new Error(`Managed uv ${release.version} failed its post-install probe.`);
          }
          return executable;
        },
      });
      return { ...installed, source: 'download' };
    },
  });
}

async function findAvailableUv(
  context: UvSetupContext,
): Promise<ResolvedUv | null> {
  for await (const external of findExecutables(['uv'], context.cwd, context.env)) {
    const resolved = await probeUv(external, context);
    if (resolved) {
      context.log('Using uv from PATH.', { path: resolved.path });
      return { ...resolved, source: 'path' };
    }
    context.log('Skipping incompatible uv from PATH.', { path: external });
  }
  return findCachedUv(context);
}

async function findCachedUv(
  context: UvSetupContext,
): Promise<ResolvedUv | null> {
  const root = uvInstallRoot(context);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  let versions = entries
    .filter(entry => entry.isDirectory() && validVersion(entry.name) === entry.name)
    .map(entry => entry.name);
  while (versions.length > 0) {
    const version = maxSatisfying(versions, context.specifier);
    if (!version) return null;
    const resolved = await probeUv(uvExecutable(context, version), context, version);
    if (resolved) {
      context.log('Using cached uv.', { path: resolved.path, version });
      return { ...resolved, source: 'cache' };
    }
    versions = versions.filter(candidate => candidate !== version);
  }
  return null;
}

async function probeUv(
  executable: string,
  context: UvSetupContext,
  expectedVersion?: string,
): Promise<Omit<ResolvedUv, 'source'> | null> {
  try {
    const output = await capture(executable, ['--version'], context.cwd, context.env);
    const version = validVersion(output.match(/^uv\s+(\S+)/iu)?.[1] ?? '');
    if (!version || expectedVersion && version !== expectedVersion ||
        !maxSatisfying([version], context.specifier)) return null;
    return { path: path.normalize(executable), version };
  } catch {
    return null;
  }
}

async function resolveUvRelease(context: UvSetupContext): Promise<UvRelease> {
  const catalog = await ensureUvReleaseCatalog(context);
  const version = maxSatisfying(catalog.releases.map(release => release.version), context.specifier);
  if (!version) throw new Error(`No published uv release satisfies ${context.specifier}.`);
  context.log('Selected uv release.', { version });
  const release = catalog.releases.find(candidate => candidate.version === version);
  if (!release) throw new Error(`uv release metadata for ${version} is incomplete.`);
  return release;
}

async function ensureUvReleaseCatalog(context: UvSetupContext): Promise<UvReleaseCatalog> {
  const file = uvReleaseMetadataFile(context);
  const stale = await readUvReleaseCatalog(file);
  try {
    return await withProvisioningLock({
      key: `uv-metadata:${canonicalPath(file)}`,
      log: context.log,
      check: () => readFreshUvReleaseCatalog(file),
      mutate: async () => {
        context.log('Refreshing uv release catalog.', { file });
        const catalog = await fetchUvReleaseCatalog(context);
        await writeUvReleaseCatalog(file, catalog);
        return catalog;
      },
    });
  } catch (error) {
    const fallback = await readUvReleaseCatalog(file) ?? stale;
    if (fallback && maxSatisfying(
      fallback.releases.map(release => release.version),
      context.specifier,
    )) {
      context.log('Using stale uv release catalog after refresh failure.', {
        error: error instanceof Error ? error.message : String(error),
      });
      return fallback;
    }
    throw error;
  }
}

async function fetchUvReleaseCatalog(context: UvSetupContext): Promise<UvReleaseCatalog> {
  const failures: Error[] = [];
  const dispatcher = proxyDispatcher(context.env);
  try {
    for (const url of uvManifestUrls(context.env)) {
      try {
        context.log('Downloading uv release manifest.', { url });
        const text = await downloadText(url, METADATA_TIMEOUT_MS, dispatcher, context.log);
        const releases = parseUvManifest(text);
        if (releases.length === 0) {
          throw new Error('The uv release manifest contained no compatible platform builds.');
        }
        return { fetchedAt: Date.now(), releases };
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
  } finally {
    await dispatcher?.close();
  }
  throw new AggregateError(failures, 'Could not download the official uv release manifest.');
}

function parseUvManifest(text: string): UvRelease[] {
  const platforms = uvPlatforms();
  const releases: UvRelease[] = [];
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const value = JSON.parse(line) as unknown;
    if (!value || typeof value !== 'object') continue;
    const entry = value as { artifacts?: unknown; version?: unknown };
    const version = typeof entry.version === 'string' ? validVersion(entry.version) : null;
    if (!version || !Array.isArray(entry.artifacts)) continue;
    const artifacts = entry.artifacts.flatMap(candidate => {
      const result = uvManifestArtifactSchema.safeParse(candidate);
      return result.success ? [result.data] : [];
    });
    const artifact = platforms.flatMap(platform =>
      artifacts.filter(candidate => candidate.platform === platform)
    ).at(0);
    if (artifact) releases.push({ artifact, version });
  }
  return releases;
}

async function readFreshUvReleaseCatalog(file: string): Promise<UvReleaseCatalog | null> {
  const catalog = await readUvReleaseCatalog(file);
  if (!catalog) return null;
  const age = Date.now() - catalog.fetchedAt;
  return age >= 0 && age < RELEASE_METADATA_TTL_MS ? catalog : null;
}

async function readUvReleaseCatalog(file: string): Promise<UvReleaseCatalog | null> {
  try {
    return parseUvReleaseCatalog(JSON.parse(await readFile(file, 'utf8')) as unknown);
  } catch {
    return null;
  }
}

function parseUvReleaseCatalog(value: unknown): UvReleaseCatalog | null {
  const result = uvReleaseCatalogSchema.safeParse(value);
  return result.success ? result.data : null;
}

async function writeUvReleaseCatalog(file: string, catalog: UvReleaseCatalog): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const staged = path.join(path.dirname(file), `.${path.basename(file)}.${uniqueSuffix()}.tmp`);
  try {
    await writeFile(staged, `${JSON.stringify(catalog)}\n`, { encoding: 'utf8', flag: 'wx' });
    if (process.platform === 'win32') await rm(file, { force: true });
    await rename(staged, file);
  } finally {
    await rm(staged, { force: true });
  }
}

async function installUv(release: UvRelease, context: UvSetupContext): Promise<void> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'pyfig-uv-'));
  const dispatcher = proxyDispatcher(context.env);
  context.log('Installing a checksum-verified official uv artifact.', {
    platform: release.artifact.platform,
    version: release.version,
  });
  try {
    const failures: Error[] = [];
    let archive: string | null = null;
    for (const [index, url] of uvArtifactUrls(context.env, release).entries()) {
      const extension = release.artifact.archiveFormat === 'zip' ? '.zip' : '.tar.gz';
      const candidate = path.join(temporary, `uv-${index}${extension}`);
      try {
        await download(url, candidate, dispatcher, context.log);
        const actual = await sha256File(candidate);
        if (actual !== release.artifact.sha256) {
          throw new Error(`uv artifact checksum mismatch from ${url}.`);
        }
        archive = candidate;
        break;
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(String(error)));
        await rm(candidate, { force: true });
      }
    }
    if (!archive) {
      throw new AggregateError(failures, `Could not download uv ${release.version}'s artifact.`);
    }

    const extracted = path.join(temporary, 'extracted');
    await mkdir(extracted, { recursive: true });
    const source = await extractUvExecutable(archive, release.artifact.archiveFormat, extracted);
    if (!source) throw new Error('The verified uv artifact did not contain the uv executable.');
    await publishUv(source, release.version, context);
    context.log('Installed uv release.', {
      path: uvExecutable(context, release.version),
      version: release.version,
    });
  } finally {
    await dispatcher?.close();
    await rm(temporary, { recursive: true, force: true });
  }
}

async function extractUvExecutable(
  archive: string,
  archiveFormat: UvArtifact['archiveFormat'],
  destination: string,
): Promise<string | null> {
  const executableName = process.platform === 'win32' ? 'uv.exe' : 'uv';
  if (archiveFormat === 'tar.gz') {
    await tar.x({
      cwd: destination,
      file: archive,
      filter: entry => path.posix.basename(entry) === executableName,
      strict: true,
    });
    return findFile(destination, executableName);
  }

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

async function publishUv(
  source: string,
  version: string,
  context: UvSetupContext,
): Promise<void> {
  const installDirectory = uvInstallDirectory(context, version);
  await mkdir(installDirectory, { recursive: true });
  const executable = uvExecutable(context, version);
  const staged = path.join(installDirectory, `.${path.basename(executable)}.${uniqueSuffix()}.tmp`);
  try {
    await copyFile(source, staged);
    if (process.platform !== 'win32') await chmod(staged, 0o755);
    if (!await probeUv(staged, { ...context, specifier: `==${version}` })) {
      throw new Error(`Downloaded uv executable is not version ${version}.`);
    }
    if (process.platform === 'win32') await rm(executable, { force: true });
    await rename(staged, executable);
  } finally {
    await rm(staged, { force: true });
  }
}

async function download(
  url: string,
  destination: string,
  dispatcher: EnvHttpProxyAgent | undefined,
  log: DebugLogger,
): Promise<void> {
  log('Downloading file.', { destination, url });
  const response = await fetch(url, {
    dispatcher,
    redirect: 'follow',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Could not download ${url}: HTTP ${response.status}.`);
  }
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(destination, { flags: 'wx' }),
  );
  log('Downloaded file.', { destination, url });
}

async function downloadText(
  url: string,
  timeoutMs: number,
  dispatcher: EnvHttpProxyAgent | undefined,
  log: DebugLogger,
): Promise<string> {
  log('Downloading text.', { url });
  const response = await fetch(url, {
    dispatcher,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Could not download ${url}: HTTP ${response.status}.`);
  }
  const text = await response.text();
  log('Downloaded text.', { bytes: Buffer.byteLength(text), url });
  return text;
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

function proxyDispatcher(env: NodeJS.ProcessEnv): EnvHttpProxyAgent | undefined {
  const httpProxy = environmentValue(env, 'http_proxy') ?? environmentValue(env, 'HTTP_PROXY');
  const httpsProxy = environmentValue(env, 'https_proxy') ?? environmentValue(env, 'HTTPS_PROXY');
  if (!httpProxy && !httpsProxy) return undefined;
  return new EnvHttpProxyAgent({
    httpProxy,
    httpsProxy,
    noProxy: environmentValue(env, 'no_proxy') ?? environmentValue(env, 'NO_PROXY'),
  });
}

interface ProvisioningOptions<T> {
  check: () => Promise<T | null>;
  key: string;
  log: DebugLogger;
  mutate: () => Promise<T>;
}

/** Apply Loqkit's pre-lock and post-lock predicates to one cache mutation. */
async function withProvisioningLock<T>(options: ProvisioningOptions<T>): Promise<T> {
  let existing: { value: T } | undefined;
  options.log('Acquiring provisioning lock.', { key: options.key });
  const result = await withLock(
    { resource: options.key },
    options.mutate,
    {
      key: options.key,
      name: 'Pyfig uv setup',
      namespace: 'pyfig',
      timeout: COORDINATION_TIMEOUT_MS,
      predicate: async () => {
        const value = await options.check();
        if (value === null) return true;
        existing = { value };
        return false;
      },
    },
  );
  options.log('Provisioning lock completed.', { key: options.key, state: result.context.state });
  if (result.context.state === 'executed') return result.value as T;
  if (existing) return existing.value;
  throw new Error(`Provisioning check for ${options.key} did not produce uv.`);
}

function uvManifestUrls(env: NodeJS.ProcessEnv): string[] {
  const customAstral = environmentValue(env, 'UV_ASTRAL_MIRROR_URL');
  if (customAstral) {
    return [`${trimUrl(customAstral)}/github/versions/main/v1/uv.ndjson`];
  }
  if (customArtifactBase(env)) {
    throw new Error(
      'A custom UV installer base also requires UV_ASTRAL_MIRROR_URL for release metadata.',
    );
  }
  return [
    `${DEFAULT_ASTRAL_RELEASES}/github/versions/main/v1/uv.ndjson`,
    `${DEFAULT_RAW_GITHUB}/astral-sh/versions/main/v1/uv.ndjson`,
  ];
}

function uvArtifactUrls(
  env: NodeJS.ProcessEnv,
  release: UvRelease,
): string[] {
  const asset = path.posix.basename(new URL(release.artifact.url).pathname);
  const artifactBase = customArtifactBase(env);
  if (artifactBase) {
    return [
      `${trimUrl(artifactBase)}/astral-sh/uv/releases/download/${release.version}/${asset}`,
    ];
  }
  const customAstral = environmentValue(env, 'UV_ASTRAL_MIRROR_URL');
  if (customAstral) {
    return [
      `${trimUrl(customAstral)}/github/uv/releases/download/${release.version}/${asset}`,
    ];
  }
  return [
    `${DEFAULT_ASTRAL_RELEASES}/github/uv/releases/download/${release.version}/${asset}`,
    release.artifact.url,
  ];
}

function customArtifactBase(env: NodeJS.ProcessEnv): string | undefined {
  return environmentValue(env, 'UV_INSTALLER_GHE_BASE_URL') ??
    environmentValue(env, 'UV_INSTALLER_GITHUB_BASE_URL');
}

function uvCacheDirectory(env: NodeJS.ProcessEnv): string {
  const configured = environmentValue(env, 'PYFIG_CACHE_DIR');
  if (configured) return path.resolve(configured);
  const home = environmentValue(env, process.platform === 'win32' ? 'USERPROFILE' : 'HOME') ??
    os.homedir();
  const root = process.platform === 'win32'
    ? environmentValue(env, 'LOCALAPPDATA') ?? path.join(home, 'AppData', 'Local')
    : process.platform === 'darwin'
      ? path.join(home, 'Library', 'Caches')
      : environmentValue(env, 'XDG_CACHE_HOME') ?? path.join(home, '.cache');
  return path.resolve(root, 'pyfig');
}

function uvInstallRoot(context: UvSetupContext): string {
  return path.join(context.cache, 'tools', 'uv');
}

function uvInstallDirectory(context: UvSetupContext, version: string): string {
  return path.join(uvInstallRoot(context), version);
}

function uvExecutable(context: UvSetupContext, version: string): string {
  return path.join(
    uvInstallDirectory(context, version),
    process.platform === 'win32' ? 'uv.exe' : 'uv',
  );
}

function uvReleaseMetadataFile(context: UvSetupContext): string {
  return path.join(context.cache, 'metadata', 'uv-releases.json');
}

function uvPlatforms(): string[] {
  const architecture = process.arch === 'x64'
    ? 'x86_64'
    : process.arch === 'arm64'
      ? 'aarch64'
      : process.arch === 'ia32'
        ? 'i686'
        : null;
  if (!architecture) throw new Error(`uv setup does not support architecture ${process.arch}.`);
  if (process.platform === 'win32') return [`${architecture}-pc-windows-msvc`];
  if (process.platform === 'darwin') return [`${architecture}-apple-darwin`];
  if (process.platform === 'linux') {
    const report = process.report?.getReport() as {
      header?: { glibcVersionRuntime?: string };
    } | undefined;
    const gnu = `${architecture}-unknown-linux-gnu`;
    const musl = `${architecture}-unknown-linux-musl`;
    return report?.header?.glibcVersionRuntime ? [gnu, musl] : [musl, gnu];
  }
  throw new Error(`uv setup does not support platform ${process.platform}.`);
}

function canonicalPath(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function trimUrl(value: string): string {
  return value.replace(/\/+$/u, '');
}

function uniqueSuffix(): string {
  return `${process.pid}.${randomUUID()}`;
}
