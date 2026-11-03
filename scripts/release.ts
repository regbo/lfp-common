import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runBun, runCommand } from './process.ts';
import {
  gitIdentityEmail,
  githubRepositoryFromRemote,
  isPublicGitHubIdentity,
  latestReleaseVersion,
  planRelease,
  registryVersionUrl,
  type ReleaseIncrement,
} from './release-lib.ts';
import {
  ROOT,
  WORKSPACES,
  readManifest,
  sharedVersion,
} from './workspaces.ts';

const args = new Set(process.argv.slice(2));
const increments = (['patch', 'minor', 'major'] as const).filter(value => args.has(value));
if (increments.length > 1) throw new Error('Choose only one increment: patch, minor, or major.');
const knownArgs = new Set(['patch', 'minor', 'major', '--dry-run', '--initial']);
const unknownArgs = [...args].filter(value => !knownArgs.has(value));
if (unknownArgs.length > 0) throw new Error(`Unknown release argument: ${unknownArgs.join(', ')}.`);

const increment: ReleaseIncrement = increments[0] ?? 'patch';
const dryRun = args.has('--dry-run');
const initial = args.has('--initial');
const remote = 'origin';
const releaseBranch = 'main';
const versionFiles = [
  '.projenrc.ts',
  'package.json',
  'bun.lock',
  ...WORKSPACES.flatMap(workspace => [
    `${workspace.path}/package.json`,
    `${workspace.path}/src/_generated/metadata.ts`,
  ]),
] as const;
const snapshots = new Map<string, { readonly content: Buffer; readonly mode: number }>();
for (const filename of versionFiles) {
  const absolutePath = path.join(ROOT, filename);
  const [content, metadata] = await Promise.all([readFile(absolutePath), stat(absolutePath)]);
  snapshots.set(filename, { content, mode: metadata.mode & 0o777 });
}
let historyCreated = false;
let pushed = false;
let versionChanged = false;

try {
  await assertCleanWorkspace();
  await assertReleaseIdentity();
  const branch = await git(['branch', '--show-current']);
  if (branch !== releaseBranch) {
    throw new Error(`Release must run from ${releaseBranch}, not ${branch || '<detached>'}.`);
  }

  const remoteUrl = await git(['remote', 'get-url', remote]);
  const rootManifest = await readManifest(ROOT);
  const configuredRemote = typeof rootManifest.repository === 'string'
    ? rootManifest.repository
    : rootManifest.repository?.url;
  const configuredRepository = configuredRemote
    ? githubRepositoryFromRemote(configuredRemote)
    : undefined;
  if (!configuredRepository || githubRepositoryFromRemote(remoteUrl) !== configuredRepository) {
    throw new Error(`${remote} must match the repository configured in package.json.`);
  }

  await git(['fetch', '--prune', remote, releaseBranch]);
  const [localHead, upstreamHead, remoteHeads] = await Promise.all([
    git(['rev-parse', 'HEAD']),
    git(['rev-parse', '@{upstream}']),
    git(['ls-remote', '--heads', remote, `refs/heads/${releaseBranch}`]),
  ]);
  const remoteHead = remoteHeads.split(/\s+/u)[0];
  if (!remoteHead || localHead !== upstreamHead || localHead !== remoteHead) {
    throw new Error('Local main must exactly match its GitHub upstream before releasing.');
  }

  const remoteTags = await git(['ls-remote', '--tags', '--refs', remote]);
  const currentVersion = await sharedVersion();
  const plan = planRelease({
    increment,
    initial,
    latestRemoteVersion: latestReleaseVersion(remoteTags),
    manifestVersion: currentVersion,
  });
  const tag = `v${plan.nextVersion}`;
  if (remoteTags.includes(`refs/tags/${tag}`)) throw new Error(`Remote tag ${tag} already exists.`);
  if (await git(['tag', '--list', tag])) throw new Error(`Local tag ${tag} already exists.`);

  for (const workspace of WORKSPACES) {
    const response = await fetch(registryVersionUrl(workspace.name, plan.nextVersion), {
      redirect: 'error',
    });
    if (response.ok) throw new Error(`${workspace.name}@${plan.nextVersion} already exists on npm.`);
    if (response.status !== 404) {
      throw new Error(
        `Could not verify ${workspace.name}@${plan.nextVersion}: HTTP ${response.status}.`,
      );
    }
  }

  console.log(
    `${dryRun ? 'Dry run' : 'Release'}: ${plan.currentVersion ?? 'initial'} -> ${plan.nextVersion} (${tag}).`,
  );
  if (plan.nextVersion !== currentVersion) {
    await updateSharedVersion(plan.nextVersion);
    versionChanged = true;
  }

  await runBun(['run', 'projen'], {
    cwd: ROOT,
    env: { PROJEN_DISABLE_POST: '1' },
    inherit: true,
  });
  await runBun(['install'], { cwd: ROOT, inherit: true });
  await runBun(['run', 'verify'], { cwd: ROOT, inherit: true });

  if (dryRun) {
    console.log(`Dry run passed for ${tag}; managed version files will be restored.`);
  } else {
    const changed = await changedPaths();
    const unexpected = changed.filter(filename => !versionFiles.includes(filename as never));
    if (unexpected.length > 0) {
      throw new Error(`Release changed unexpected files: ${unexpected.join(', ')}.`);
    }

    if (changed.length > 0) {
      await git(['add', '--', ...versionFiles]);
      await runCommand('git', ['commit', '-m', `release: ${tag}`], {
        cwd: ROOT,
        inherit: true,
      });
      historyCreated = true;
    }

    await git(['tag', tag]);
    historyCreated = true;
    await runCommand('git', [
      'push',
      '--atomic',
      remote,
      `HEAD:refs/heads/${releaseBranch}`,
      `refs/tags/${tag}`,
    ], { cwd: ROOT, inherit: true });
    pushed = true;
    console.log(`Pushed ${tag}; the trusted publish workflow can now publish all packages.`);
  }
} catch (error) {
  if (historyCreated && !pushed) {
    console.error('Release history exists locally; inspect the commit and tag before retrying the push.');
  }
  throw error;
} finally {
  if (versionChanged && (dryRun || (!historyCreated && !pushed))) {
    for (const [filename, snapshot] of snapshots) {
      const absolutePath = path.join(ROOT, filename);
      await chmod(absolutePath, 0o600);
      try {
        await writeFile(absolutePath, snapshot.content);
      } finally {
        await chmod(absolutePath, snapshot.mode);
      }
    }
  }
}

if (dryRun) await assertCleanWorkspace();

async function updateSharedVersion(version: string): Promise<void> {
  const filename = path.join(ROOT, '.projenrc.ts');
  const source = await readFile(filename, 'utf8');
  const updated = source.replace(
    /const VERSION = '[^']+';/u,
    `const VERSION = '${version}';`,
  );
  if (updated === source) throw new Error('Could not find the shared VERSION in .projenrc.ts.');
  await writeFile(filename, updated, 'utf8');
}

async function assertReleaseIdentity(): Promise<void> {
  for (const kind of ['AUTHOR', 'COMMITTER'] as const) {
    const identity = await git(['var', `GIT_${kind}_IDENT`]);
    const email = gitIdentityEmail(identity);
    if (!email || !isPublicGitHubIdentity(email)) {
      throw new Error(`${kind.toLowerCase()} email must be a GitHub noreply address.`);
    }
  }
}

async function assertCleanWorkspace(): Promise<void> {
  const status = await git(['status', '--porcelain=v1', '--untracked-files=all']);
  if (status) throw new Error('Release requires a clean worktree.');
}

async function changedPaths(): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    git(['diff', '--name-only']),
    git(['ls-files', '--others', '--exclude-standard']),
  ]);
  return [...new Set(`${tracked}\n${untracked}`.split(/\r?\n/u).filter(Boolean))].sort();
}

function git(args: readonly string[]): Promise<string> {
  return runCommand('git', args, { cwd: ROOT });
}
