import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const originalManifest = await Bun.file('package.json').text();
const manifest = JSON.parse(originalManifest) as {
  name: string;
  repository: { url: string };
  version: string;
  [key: string]: unknown;
};

const status = await runCommand('git', ['status', '--porcelain']);
if (status) throw new Error('Release requires a clean worktree');
const branch = await runCommand('git', ['branch', '--show-current']);
if (branch !== releaseBranch) throw new Error(`Release must run from ${releaseBranch}, not ${branch}`);
const remote = (await runCommand('git', ['config', `branch.${branch}.remote`])) || 'origin';
const remoteUrl = await runCommand('git', ['remote', 'get-url', remote]);
const remoteRepository = githubRepositoryFromRemote(remoteUrl);
const manifestRepository = githubRepositoryFromRemote(manifest.repository.url);
if (!remoteRepository || remoteRepository !== manifestRepository) {
  throw new Error('Git remote and package repository do not identify the same GitHub repository');
}

for (const kind of ['AUTHOR', 'COMMITTER'] as const) {
  const identity = await runCommand('git', ['var', `GIT_${kind}_IDENT`]);
  const email = gitIdentityEmail(identity);
  if (!email || !isPublicGitHubIdentity(email)) {
    throw new Error(`${kind.toLowerCase()} email is not a GitHub noreply address`);
  }
}

await runCommand('git', ['fetch', remote, releaseBranch]);
const localHead = await runCommand('git', ['rev-parse', 'HEAD']);
const upstreamHead = await runCommand('git', ['rev-parse', '@{upstream}']);
const remoteHead = (await runCommand('git', [
  'ls-remote', '--heads', remote, `refs/heads/${releaseBranch}`,
])).split(/\s+/)[0];
if (!remoteHead || localHead !== upstreamHead || localHead !== remoteHead) {
  throw new Error('Local HEAD must exactly match its GitHub upstream');
}

const remoteTags = await runCommand('git', ['ls-remote', '--tags', '--refs', remote]);
const latestRemoteVersion = latestReleaseVersion(remoteTags);
const registryPackageResponse = await fetch(registryPackageUrl(manifest.name));
let registryLatestVersion: string | undefined;
if (registryPackageResponse.ok) {
  const document = (await registryPackageResponse.json()) as {
    'dist-tags'?: { latest?: string };
  };
  registryLatestVersion = document['dist-tags']?.latest;
} else if (registryPackageResponse.status !== 404) {
  throw new Error(`npm registry package check failed with HTTP ${registryPackageResponse.status}`);
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
const localTag = Bun.spawnSync(['git', 'show-ref', '--verify', '--quiet', `refs/tags/${tag}`]);
if (localTag.exitCode === 0) throw new Error(`Local tag ${tag} already exists`);

const versionResponse = await fetch(registryVersionUrl(manifest.name, plan.nextVersion));
if (versionResponse.ok) throw new Error(`${manifest.name}@${plan.nextVersion} already exists on npm`);
if (versionResponse.status !== 404) {
  throw new Error(`npm registry version check failed with HTTP ${versionResponse.status}`);
}

console.log(
  `${dryRun ? 'Dry run' : 'Release'}: ${plan.currentVersion ?? 'unpublished'} -> ${plan.nextVersion} (${tag})`,
);
const versionChanged = manifest.version !== plan.nextVersion;
manifest.version = plan.nextVersion;
await Bun.write('package.json', `${JSON.stringify(manifest, null, 2)}\n`);

let releaseCommitCreated = false;
const archiveRoot = await mkdtemp(join(tmpdir(), 'pynect-release-'));
try {
  await runCommand(process.execPath, ['run', 'typecheck'], { inherit: true });
  await runCommand(process.execPath, ['run', 'typecheck:release'], { inherit: true });
  await runCommand(process.execPath, ['test'], { inherit: true });
  await runCommand(process.execPath, ['run', 'build'], { inherit: true });
  const filename = `${manifest.name}-${plan.nextVersion}.tgz`;
  await runCommand(process.execPath, [
    'pm', 'pack', '--ignore-scripts', '--destination', archiveRoot,
  ], { inherit: true });
  const audit = await auditArchive(join(archiveRoot, filename), manifest.name, plan.nextVersion);
  console.log(`Audited ${audit.name}@${audit.version} (${audit.files.length} files)`);

  if (dryRun) {
    await Bun.write('package.json', originalManifest);
    const finalStatus = await runCommand('git', ['status', '--porcelain']);
    if (finalStatus) throw new Error('Dry run did not restore the clean worktree');
    console.log(`Dry run complete; ${tag} was not created`);
  } else {
    await runCommand('git', ['add', '--', 'package.json']);
    await runCommand(
      'git',
      ['commit', ...(versionChanged ? [] : ['--allow-empty']), '-m', `release: ${tag}`],
      { inherit: true },
    );
    releaseCommitCreated = true;
    await runCommand('git', ['tag', tag]);
    await runCommand('git', [
      'push', '--atomic', remote,
      `HEAD:refs/heads/${releaseBranch}`,
      `refs/tags/${tag}`,
    ], { inherit: true });
    console.log(`Published ${tag} to GitHub; trusted publishing will publish npm`);
  }
} catch (error) {
  if (!releaseCommitCreated) {
    await Bun.write('package.json', originalManifest);
    Bun.spawnSync(['git', 'restore', '--staged', '--', 'package.json']);
  } else {
    console.error(`Release commit and ${tag} may exist locally; inspect them before retrying`);
  }
  throw error;
} finally {
  await rm(archiveRoot, { force: true, recursive: true });
}
