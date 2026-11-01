import { access, appendFile, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { auditArchive } from './archive.ts';
import {
  computeNativeFingerprint,
  nativeBuildConfig,
  validatePrebuildMetadata,
  type NativePrebuildMetadata,
} from './native-fingerprint.js';
import { githubRepositoryFromRemote, registryVersionUrl } from './release-lib.ts';
import { runCommand } from './process.ts';

const manifest = (await Bun.file('package.json').json()) as {
  name: string;
  repository: { url: string };
  version: string;
};
const tag = process.env.GITHUB_REF_NAME;
if (tag !== `v${manifest.version}`) {
  throw new Error(`Tag ${tag ?? '<missing>'} does not match v${manifest.version}`);
}
const expectedRepository = githubRepositoryFromRemote(manifest.repository.url);
if (!expectedRepository || process.env.GITHUB_REPOSITORY !== expectedRepository) {
  throw new Error(
    `Workflow repository ${process.env.GITHUB_REPOSITORY ?? '<missing>'} does not match package repository ${expectedRepository ?? '<invalid>'}`,
  );
}

const registryResponse = await fetch(registryVersionUrl(manifest.name, manifest.version));
if (registryResponse.ok) throw new Error(`${manifest.name}@${manifest.version} already exists on npm`);
if (registryResponse.status !== 404) {
  throw new Error(`npm registry check failed with HTTP ${registryResponse.status}`);
}

const nativeFingerprint = computeNativeFingerprint();
const expectedTargets = nativeBuildConfig.targets
  .map(target => `${target.platform}-${target.arch}`)
  .sort();
const actualTargets = (await readdir(resolve('prebuilds'), { withFileTypes: true }))
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .sort();
if (JSON.stringify(actualTargets) !== JSON.stringify(expectedTargets)) {
  throw new Error(
    `Native prebuild inventory is ${actualTargets.join(', ')}; expected ${expectedTargets.join(', ')}`,
  );
}
for (const target of nativeBuildConfig.targets) {
  const targetName = `${target.platform}-${target.arch}`;
  const directory = resolve('prebuilds', targetName);
  await access(join(directory, 'pynect_addon.node'));
  const metadata = JSON.parse(
    await readFile(join(directory, 'pynect-prebuild.json'), 'utf8'),
  ) as NativePrebuildMetadata;
  if (!validatePrebuildMetadata(metadata, target, nativeFingerprint)) {
    throw new Error(`Invalid or stale native prebuild metadata for ${targetName}`);
  }
}

const archiveRoot = await mkdtemp(
  join(process.env.RUNNER_TEMP || tmpdir(), 'pynect-publish-'),
);
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const packed = JSON.parse(await runCommand(npmCommand, [
  'pack',
  '--ignore-scripts',
  '--json',
  '--pack-destination',
  archiveRoot,
])) as Array<{ filename?: string }>;
if (packed.length !== 1 || !packed[0]?.filename) {
  throw new Error(`Expected one npm archive, received ${packed.length}`);
}
const archivePath = resolve(archiveRoot, packed[0].filename);
const audit = await auditArchive(archivePath, manifest.name, manifest.version);
console.log(`Audited ${audit.name}@${audit.version} (${audit.files.length} files)`);

const outputPath = process.env.GITHUB_OUTPUT;
if (!outputPath) throw new Error('GITHUB_OUTPUT is unavailable');
await appendFile(outputPath, `tarball=${archivePath}\n`, 'utf8');
