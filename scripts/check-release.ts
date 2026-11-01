import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import semver from 'semver';

interface PackageManifest {
  name: string;
  version: string;
  private?: boolean;
  repository?: { url?: string } | string;
  publishConfig?: { access?: string; provenance?: boolean; registry?: string };
}

const manifest = await Bun.file(path.join(import.meta.dir, '..', 'package.json')).json() as PackageManifest;
const version = semver.parse(manifest.version);
if (!version) throw new Error(`package.json contains an invalid version: ${manifest.version}`);
if (manifest.private) throw new Error('Refusing to release a private package.');

const expectedTag = `v${version.version}`;
const actualTag = process.env['GITHUB_REF_NAME'] ?? process.argv[2];
if (actualTag !== expectedTag) {
  throw new Error(`Release tag ${actualTag ?? '<missing>'} must exactly match ${expectedTag}.`);
}

const repositoryUrl = typeof manifest.repository === 'string'
  ? manifest.repository
  : manifest.repository?.url;
if (repositoryUrl !== 'git+https://github.com/regbo/pyfig.git') {
  throw new Error('package.json repository must exactly identify regbo/pyfig.');
}
if (manifest.publishConfig?.access !== 'public' ||
    manifest.publishConfig.registry !== 'https://registry.npmjs.org' ||
    manifest.publishConfig.provenance !== true) {
  throw new Error('publishConfig must require public npm publication with provenance.');
}

const registryVersion = `https://registry.npmjs.org/${encodeURIComponent(manifest.name)}/${version.version}`;
const response = await fetch(registryVersion, { redirect: 'error' });
if (response.ok) throw new Error(`${manifest.name}@${version.version} is already published.`);
if (response.status !== 404) {
  throw new Error(`Could not verify npm version availability: HTTP ${response.status}.`);
}

const prereleaseChannel = version.prerelease.find((part): part is string => typeof part === 'string');
const distTag = prereleaseChannel ?? (version.prerelease.length > 0 ? 'next' : 'latest');
const output = process.env['GITHUB_OUTPUT'];
if (output) await appendFile(output, `dist-tag=${distTag}\n`, 'utf8');
console.log(`Release validated: ${manifest.name}@${version.version} (${distTag}).`);
