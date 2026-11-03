import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { auditArchive } from './archive.ts';
import {
  githubRepositoryFromRemote,
  gitIdentityEmail,
  isPublicGitHubIdentity,
  latestReleaseVersion,
  planRelease,
  registryPackageUrl,
  registryVersionUrl,
  type ReleaseIncrement,
} from './release-lib.ts';
import { runCommand } from './process.ts';

const root = resolve(import.meta.dir, '..');
const releaseBranch = 'main';
const args = new Set(process.argv.slice(2));
const increments = (['patch', 'minor', 'major'] as const).filter(item => args.has(item));
if (increments.length > 1) throw new Error('Choose only one increment: patch, minor, or major');
const knownArgs = new Set(['patch', 'minor', 'major', '--dry-run', '--initial']);
const unknownArgs = [...args].filter(item => !knownArgs.has(item));
if (unknownArgs.length) throw new Error(`Unknown release argument: ${unknownArgs.join(', ')}`);
const increment: ReleaseIncrement = increments[0] ?? 'patch';
const dryRun = args.has('--dry-run');
const initial = args.has('--initial');
const manifestPath = join(root, 'package.json');
const originalManifest = await Bun.file(manifestPath).text();
const manifest = JSON.parse(originalManifest) as {
  name: string;
  repository: { url: string };
  version: string;
  [key: string]: unknown;
};

if (await runCommand('git', ['status', '--porcelain'], { cwd: root })) {
  throw new Error('Release requires a clean worktree');
}
const branch = await runCommand('git', ['branch', '--show-current'], { cwd: root });
if (branch !== releaseBranch) throw new Error(`Release must run from ${releaseBranch}, not ${branch}`);
const remote = (await runCommand('git', ['config', `branch.${branch}.remote`], { cwd: root })) || 'origin';
const remoteUrl = await runCommand('git', ['remote', 'get-url', remote], { cwd: root });
if (githubRepositoryFromRemote(remoteUrl) !== githubRepositoryFromRemote(manifest.repository.url)) {
  throw new Error('Git remote and package repository do not identify the same GitHub repository');
}
for (const kind of ['AUTHOR', 'COMMITTER'] as const) {
  const identity = await runCommand('git', ['var', `GIT_${kind}_IDENT`], { cwd: root });
  const email = gitIdentityEmail(identity);
  if (!email || !isPublicGitHubIdentity(email)) {
    throw new Error(`${kind.toLowerCase()} email is not a GitHub noreply address`);
  }
}
await runCommand('git', ['fetch', remote, releaseBranch], { cwd: root, inherit: true });
const localHead = await runCommand('git', ['rev-parse', 'HEAD'], { cwd: root });
const upstreamHead = await runCommand('git', ['rev-parse', '@{upstream}'], { cwd: root });
const remoteHead = (await runCommand('git', [
  'ls-remote', '--heads', remote, `refs/heads/${releaseBranch}`,
], { cwd: root })).split(/\s+/u)[0];
if (!remoteHead || localHead !== upstreamHead || localHead !== remoteHead) {
  throw new Error('Local HEAD must exactly match its GitHub upstream');
}
const remoteTags = await runCommand('git', ['ls-remote', '--tags', '--refs', remote], { cwd: root });
const latestRemoteVersion = latestReleaseVersion(remoteTags);
const registryResponse = await fetch(registryPackageUrl(manifest.name));
let registryLatestVersion: string | undefined;
if (registryResponse.ok) {
  const document = await registryResponse.json() as { 'dist-tags'?: { latest?: string } };
  registryLatestVersion = document['dist-tags']?.latest;
} else if (registryResponse.status !== 404) {
  throw new Error(`npm registry package check failed with HTTP ${registryResponse.status}`);
}
const plan = planRelease({
  increment,
  initial,
  latestRemoteVersion,
  manifestVersion: manifest.version,
  registryLatestVersion,
});
const tag = `v${plan.nextVersion}`;
if (remoteTags.includes(`refs/tags/${tag}`)) throw new Error(`Remote tag ${tag} already exists`);
const localTag = Bun.spawnSync(['git', 'show-ref', '--verify', '--quiet', `refs/tags/${tag}`], { cwd: root });
if (localTag.exitCode === 0) throw new Error(`Local tag ${tag} already exists`);
const versionResponse = await fetch(registryVersionUrl(manifest.name, plan.nextVersion));
if (versionResponse.ok) throw new Error(`${manifest.name}@${plan.nextVersion} already exists on npm`);
if (versionResponse.status !== 404) {
  throw new Error(`npm registry version check failed with HTTP ${versionResponse.status}`);
}

console.log(`${dryRun ? 'Dry run' : 'Release'}: ${plan.currentVersion ?? 'unpublished'} -> ${plan.nextVersion} (${tag})`);
manifest.version = plan.nextVersion;
await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
let releaseCommitCreated = false;
const archiveRoot = await mkdtemp(join(tmpdir(), 'optionkit-release-'));
try {
  await runCommand(process.execPath, ['run', 'verify'], { cwd: root, inherit: true });
  const filename = `${manifest.name}-${plan.nextVersion}.tgz`;
  await runCommand(process.execPath, [
    'pm', 'pack', '--ignore-scripts', '--destination', archiveRoot, '--quiet',
  ], { cwd: root, inherit: true });
  const audit = await auditArchive(join(archiveRoot, filename), manifest.name, plan.nextVersion);
  console.log(`Audited ${audit.name}@${audit.version} (${audit.files.length} files).`);
  if (dryRun) {
    await Bun.write(manifestPath, originalManifest);
    if (await runCommand('git', ['status', '--porcelain'], { cwd: root })) {
      throw new Error('Dry run did not restore the clean worktree');
    }
    console.log(`Dry run complete; ${tag} was not created.`);
  } else {
    await runCommand('git', ['add', '--', 'package.json'], { cwd: root });
    await runCommand('git', ['commit', '-m', `release: ${tag}`], { cwd: root, inherit: true });
    releaseCommitCreated = true;
    await runCommand('git', ['tag', tag], { cwd: root });
    await runCommand('git', [
      'push', '--atomic', remote,
      `HEAD:refs/heads/${releaseBranch}`,
      `refs/tags/${tag}`,
    ], { cwd: root, inherit: true });
    console.log(`Published ${tag} to GitHub; trusted publishing will publish npm.`);
  }
} catch (error) {
  if (!releaseCommitCreated) {
    await Bun.write(manifestPath, originalManifest);
    Bun.spawnSync(['git', 'restore', '--staged', '--', 'package.json'], { cwd: root });
  } else {
    console.error(`Release commit and ${tag} may exist locally; inspect them before retrying.`);
  }
  throw error;
} finally {
  await rm(archiveRoot, { force: true, recursive: true });
}
