import { appendFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { auditArchive } from './archive.ts';
import {
  githubRepositoryFromRemote,
  npmPackResults,
  registryVersionUrl,
} from './release-lib.ts';
import { runCommand } from './process.ts';

const root = resolve(import.meta.dir, '..');
const manifest = await Bun.file(join(root, 'package.json')).json() as {
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
  throw new Error('Workflow repository does not match package repository.');
}
const registryResponse = await fetch(registryVersionUrl(manifest.name, manifest.version));
if (registryResponse.ok) throw new Error(`${manifest.name}@${manifest.version} already exists on npm`);
if (registryResponse.status !== 404) {
  throw new Error(`npm registry check failed with HTTP ${registryResponse.status}`);
}
const archiveRoot = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), 'optionkit-publish-'));
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const packed = npmPackResults(JSON.parse(await runCommand(npmCommand, [
  'pack', '--ignore-scripts', '--json', '--pack-destination', archiveRoot,
], { cwd: root })));
if (packed.length !== 1 || !packed[0]?.filename) {
  throw new Error(`Expected one npm archive, received ${packed.length}`);
}
const archivePath = resolve(archiveRoot, packed[0].filename);
const audit = await auditArchive(archivePath, manifest.name, manifest.version);
console.log(`Audited ${audit.name}@${audit.version} (${audit.files.length} files).`);
const outputPath = process.env.GITHUB_OUTPUT;
if (!outputPath) throw new Error('GITHUB_OUTPUT is unavailable');
await appendFile(outputPath, `tarball=${archivePath}\n`, 'utf8');
