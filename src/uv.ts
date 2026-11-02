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
import { capture, environmentValue, findExecutable } from './process.js';

interface UvRelease {
  assets: string[];
  tag: string;
  version: string;
}

interface UvReleaseCatalog {
  fetchedAt: number;
  releases: UvRelease[];
}

interface UvSetupContext {
  cache: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  specifier: string;
}

const RELEASE_PAGE_SIZE = 100;
const RELEASE_MAX_PAGES = 20;
const RELEASE_METADATA_TTL_MS = 24 * 60 * 60_000;
const METADATA_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const COORDINATION_TIMEOUT_MS = 15 * 60_000;

/** Prefer a compatible PATH or cached uv, then provision an official release. */
export async function resolveUv(
  specifier: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const context: UvSetupContext = {
    cache: uvCacheDirectory(env),
    cwd,
    env,
    specifier,
  };
  const existing = await findAvailableUv(context);
  if (existing) return existing;

  const policy = createHash('sha256').update(specifier).digest('hex');
  return withProvisioningLock({
    key: `uv-policy:${canonicalPath(context.cache)}:${policy}`,
    check: () => findAvailableUv(context),
    mutate: async () => {
      const release = await resolveUvRelease(context);
      const destination = uvInstallDirectory(context, release.version);
      return withProvisioningLock({
        key: `uv-release:${canonicalPath(destination)}`,
        check: () => probeUv(uvExecutable(context, release.version), context, release.version),
        mutate: async () => {
          await installUv(release, context);
          const installed = await probeUv(
            uvExecutable(context, release.version),
            context,
            release.version,
          );
          if (!installed) {
            throw new Error(`Managed uv ${release.version} failed its post-install probe.`);
          }
          return installed;
        },
      });
    },
  });
}

async function findAvailableUv(context: UvSetupContext): Promise<string | null> {
  const external = await findExecutable('uv', context.cwd, context.env);
  if (external && await probeUv(external, context)) return external;
  return findCachedUv(context);
}

async function findCachedUv(context: UvSetupContext): Promise<string | null> {
  const root = uvInstallRoot(context);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  let versions = entries
    .filter(entry => entry.isDirectory() && validVersion(entry.name) === entry.name)
    .map(entry => entry.name);
  while (versions.length > 0) {
    const version = maxSatisfying(versions, context.specifier);
    if (!version) return null;
    const executable = await probeUv(uvExecutable(context, version), context, version);
    if (executable) return executable;
    versions = versions.filter(candidate => candidate !== version);
  }
  return null;
}

async function probeUv(
  executable: string,
  context: UvSetupContext,
  expectedVersion?: string,
): Promise<string | null> {
  try {
    const output = await capture(executable, ['--version'], context.cwd, context.env);
    const version = validVersion(output.match(/^uv\s+(\S+)/iu)?.[1] ?? '');
    return version && (!expectedVersion || version === expectedVersion) &&
        maxSatisfying([version], context.specifier)
      ? executable
      : null;
  } catch {
    return null;
  }
}

async function resolveUvRelease(context: UvSetupContext): Promise<UvRelease> {
  const catalog = await ensureUvReleaseCatalog(context);
  const asset = uvAsset();
  const candidates = catalog.releases.filter(release =>
    release.assets.includes(asset) && release.assets.includes(`${asset}.sha256`)
  );
  const version = maxSatisfying(candidates.map(release => release.version), context.specifier);
  const release = candidates.find(candidate => candidate.version === version);
  if (!release) throw new Error(`No published uv release satisfies ${context.specifier}.`);
  return release;
}

async function ensureUvReleaseCatalog(context: UvSetupContext): Promise<UvReleaseCatalog> {
  const file = uvReleaseMetadataFile(context);
  const stale = await readUvReleaseCatalog(file);
  try {
    return await withProvisioningLock({
      key: `uv-metadata:${canonicalPath(file)}`,
      check: () => readFreshUvReleaseCatalog(file),
      mutate: async () => {
        const catalog = await fetchUvReleaseCatalog(context.env);
        await writeUvReleaseCatalog(file, catalog);
        return catalog;
      },
    });
  } catch (error) {
    const fallback = await readUvReleaseCatalog(file) ?? stale;
    if (fallback) return fallback;
    throw error;
  }
}

async function fetchUvReleaseCatalog(env: NodeJS.ProcessEnv): Promise<UvReleaseCatalog> {
  const dispatcher = proxyDispatcher(env);
  const releases = new Map<string, UvRelease>();
  let exhausted = false;
  try {
    for (let page = 1; page <= RELEASE_MAX_PAGES; page += 1) {
      const text = await downloadText(
        `https://api.github.com/repos/astral-sh/uv/releases?per_page=${RELEASE_PAGE_SIZE}&page=${page}`,
        METADATA_TIMEOUT_MS,
        dispatcher,
        githubApiHeaders(env),
      );
      const payload = JSON.parse(text) as unknown;
      if (!Array.isArray(payload)) throw new Error('GitHub returned invalid uv release metadata.');
      for (const candidate of payload) {
        if (!candidate || typeof candidate !== 'object') continue;
        const value = candidate as { assets?: unknown; draft?: unknown; tag_name?: unknown };
        if (value.draft === true || typeof value.tag_name !== 'string') continue;
        const version = validVersion(value.tag_name);
        if (version) {
          releases.set(version, {
            assets: releaseAssetNames(value.assets),
            tag: value.tag_name,
            version,
          });
        }
      }
      if (payload.length < RELEASE_PAGE_SIZE) {
        exhausted = true;
        break;
      }
    }
  } finally {
    await dispatcher?.close();
  }
  if (!exhausted) throw new Error(`uv release catalog exceeded ${RELEASE_MAX_PAGES} pages.`);
  if (releases.size === 0) throw new Error('GitHub returned no usable uv releases.');
  return { fetchedAt: Date.now(), releases: [...releases.values()] };
}

function githubApiHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const token = [environmentValue(env, 'GITHUB_TOKEN'), environmentValue(env, 'GH_TOKEN')]
    .find(value => typeof value === 'string' && value.trim().length > 0);
  if (token && /[\r\n]/u.test(token)) {
    throw new TypeError('GitHub API token must not contain line breaks.');
  }
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'pyfig',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
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
  if (!value || typeof value !== 'object') return null;
  const catalog = value as { fetchedAt?: unknown; releases?: unknown };
  if (!Number.isSafeInteger(catalog.fetchedAt) || (catalog.fetchedAt as number) < 0 ||
      !Array.isArray(catalog.releases)) return null;

  const releases: UvRelease[] = [];
  for (const candidate of catalog.releases) {
    if (!candidate || typeof candidate !== 'object') return null;
    const release = candidate as { assets?: unknown; tag?: unknown; version?: unknown };
    if (!Array.isArray(release.assets) ||
        !release.assets.every(asset => typeof asset === 'string') ||
        typeof release.tag !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(release.tag) ||
        typeof release.version !== 'string' ||
        validVersion(release.version) !== release.version) return null;
    releases.push({
      assets: release.assets as string[],
      tag: release.tag,
      version: release.version,
    });
  }
  return { fetchedAt: catalog.fetchedAt as number, releases };
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
  const asset = uvAsset();
  const baseUrl = `https://github.com/astral-sh/uv/releases/download/${release.tag}`;
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'pyfig-uv-'));
  const dispatcher = proxyDispatcher(context.env);
  try {
    const archive = path.join(temporary, asset);
    await download(`${baseUrl}/${asset}`, archive, dispatcher);
    const expected = (await downloadText(
      `${baseUrl}/${asset}.sha256`,
      DOWNLOAD_TIMEOUT_MS,
      dispatcher,
    )).trim().split(/\s+/u)[0];
    const actual = await sha256File(archive);
    if (!expected || expected.toLowerCase() !== actual.toLowerCase()) {
      throw new Error(`uv archive checksum mismatch for ${asset}.`);
    }

    const extracted = path.join(temporary, 'extracted');
    await mkdir(extracted, { recursive: true });
    const source = await extractUvExecutable(archive, asset, extracted);
    if (!source) throw new Error(`uv archive did not contain the expected executable: ${asset}.`);
    await publishUv(source, release.version, context);
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

  // Extract only uv's bytes; archive paths never become filesystem paths.
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
): Promise<void> {
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
    throw new Error(`Could not download ${url}: HTTP ${response.status}.`);
  }
  return response.text();
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

interface ProvisioningOptions<T> {
  check: () => Promise<T | null>;
  key: string;
  mutate: () => Promise<T>;
}

/** Apply Loqkit's pre-lock and post-lock predicates to one cache mutation. */
async function withProvisioningLock<T>(options: ProvisioningOptions<T>): Promise<T> {
  let existing: { value: T } | undefined;
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
  if (result.context.state === 'executed') return result.value as T;
  if (existing) return existing.value;
  throw new Error(`Provisioning check for ${options.key} did not produce uv.`);
}

function uvCacheDirectory(env: NodeJS.ProcessEnv): string {
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

function uvAsset(): string {
  const architecture = process.arch === 'x64'
    ? 'x86_64'
    : process.arch === 'arm64'
      ? 'aarch64'
      : null;
  if (!architecture) throw new Error(`uv setup does not support architecture ${process.arch}.`);
  if (process.platform === 'win32') return `uv-${architecture}-pc-windows-msvc.zip`;
  if (process.platform === 'darwin') return `uv-${architecture}-apple-darwin.tar.gz`;
  if (process.platform === 'linux') return `uv-${architecture}-unknown-linux-musl.tar.gz`;
  throw new Error(`uv setup does not support platform ${process.platform}.`);
}

function releaseAssetNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(entry => {
    if (!entry || typeof entry !== 'object') return [];
    const name = (entry as { name?: unknown }).name;
    return typeof name === 'string' ? [name] : [];
  });
}

function canonicalPath(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function uniqueSuffix(): string {
  return `${process.pid}.${randomUUID()}`;
}
