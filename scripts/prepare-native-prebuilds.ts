import { createHash, timingSafeEqual } from 'node:crypto';
import { appendFile, cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  computeNativeFingerprint,
  nativeBuildConfig,
  validatePrebuildMetadata,
  type NativePrebuildMetadata,
} from './native-fingerprint.js';
import { registryPackageUrl } from './release-lib.ts';
import { runCommand } from './process.ts';

interface RegistryVersion {
  readonly dist?: {
    readonly integrity?: string;
    readonly tarball?: string;
  };
}

interface RegistryDocument {
  readonly 'dist-tags'?: { readonly latest?: string };
  readonly versions?: Record<string, RegistryVersion>;
}

const manifest = (await Bun.file('package.json').json()) as { name: string; version: string };
const fingerprint = computeNativeFingerprint();
const matrix = JSON.stringify({ include: nativeBuildConfig.targets });
let reuse = false;
let sourceVersion = '';
let reason = 'No compatible prior npm release was found.';

try {
  const response = await fetch(registryPackageUrl(manifest.name), {
    cache: 'no-store',
    headers: { 'cache-control': 'no-cache' },
  });
  if (response.ok) {
    const registry = await response.json() as RegistryDocument;
    sourceVersion = registry['dist-tags']?.latest ?? '';
    const source = sourceVersion ? registry.versions?.[sourceVersion] : undefined;
    if (sourceVersion === manifest.version) {
      reason = `${manifest.name}@${manifest.version} is already npm latest; refusing self-reuse.`;
    } else if (source?.dist?.tarball && source.dist.integrity) {
      reuse = await downloadCompatiblePrebuilds(
        source.dist.tarball,
        source.dist.integrity,
        fingerprint,
      );
      reason = reuse
        ? `Reusing verified native prebuilds from ${manifest.name}@${sourceVersion}.`
        : `${manifest.name}@${sourceVersion} does not carry the current native fingerprint.`;
    }
  } else if (response.status !== 404) {
    reason = `Registry lookup returned HTTP ${response.status}; native prebuilds will be rebuilt.`;
  }
} catch (error) {
  reason = `Prebuild reuse was unavailable (${errorMessage(error)}); native prebuilds will be rebuilt.`;
}

const outputs = {
  fingerprint,
  matrix,
  node_major: String(nativeBuildConfig.nodeMajor),
  python_major_minor: nativeBuildConfig.pythonMajorMinor,
  reuse: String(reuse),
  source_version: sourceVersion,
  windows_arm_node_gyp: nativeBuildConfig.windowsArmNodeGyp,
};
const outputPath = process.env.GITHUB_OUTPUT;
if (outputPath) {
  await appendFile(
    outputPath,
    Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''),
    'utf8',
  );
}
console.log(reason);
console.log(JSON.stringify(outputs));

async function downloadCompatiblePrebuilds(
  tarballUrl: string,
  integrity: string,
  expectedFingerprint: string,
): Promise<boolean> {
  const response = await fetch(tarballUrl, { cache: 'no-store' });
  if (!response.ok) throw new Error(`tarball download returned HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  verifyIntegrity(archive, integrity);

  const temporary = await mkdtemp(join(tmpdir(), 'pynect-prebuild-reuse-'));
  const archivePath = join(temporary, 'package.tgz');
  const destination = resolve('prebuilds');
  try {
    await writeFile(archivePath, archive);
    await runCommand('tar', ['-xzf', archivePath, '-C', temporary]);
    const source = join(temporary, 'package', 'prebuilds');
    if (!await verifyPrebuildSet(source, expectedFingerprint)) return false;
    await rm(destination, { force: true, recursive: true });
    await cp(source, destination, { recursive: true });
    return true;
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
}

async function verifyPrebuildSet(
  prebuildRoot: string,
  expectedFingerprint: string,
): Promise<boolean> {
  let directories: string[];
  try {
    directories = (await readdir(prebuildRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort();
  } catch {
    return false;
  }
  const expected = nativeBuildConfig.targets
    .map(target => `${target.platform}-${target.arch}`)
    .sort();
  if (JSON.stringify(directories) !== JSON.stringify(expected)) return false;

  for (const target of nativeBuildConfig.targets) {
    const directory = join(prebuildRoot, `${target.platform}-${target.arch}`);
    try {
      const metadata = JSON.parse(
        await readFile(join(directory, 'pynect-prebuild.json'), 'utf8'),
      ) as NativePrebuildMetadata;
      if (!validatePrebuildMetadata(metadata, target, expectedFingerprint)) return false;
      const addon = await readFile(join(directory, 'pynect_addon.node'));
      if (addon.length === 0) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function verifyIntegrity(bytes: Buffer, integrity: string): void {
  const token = integrity.split(/\s+/u).find(value => value.startsWith('sha512-'));
  if (!token) throw new Error('npm tarball does not provide a SHA-512 integrity value');
  const expected = Buffer.from(token.slice('sha512-'.length), 'base64');
  const actual = createHash('sha512').update(bytes).digest();
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error('npm tarball integrity verification failed');
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
