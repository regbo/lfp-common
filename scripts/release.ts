import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runBun, runCommand } from './process.ts';
import {
  assertCleanWorkspace,
  assertGitOperationSafe,
  commitWorkspace,
  dropWorkspaceSnapshot,
  restoreWorkspaceSnapshot,
  workspaceStatus,
  type WorkspaceSnapshot,
} from './release-git.ts';
import {
  assertReleaseBranchState,
  gitIdentityEmail,
  githubRepositoryFromRemote,
  isPublicGitHubIdentity,
  latestReleaseVersion,
  planRelease,
  registryVersionUrl,
  type ReleaseIncrement,
} from './release-lib.ts';
import { VERSION_FILE } from './version.ts';
import {
  ROOT,
  BUN_WORKSPACES,
  PYTHON_DISTRIBUTIONS,
  PYTHON_PROJECTS,
  WORKSPACES,
  generatedPackageVersionPaths,
  pypiVersionUrl,
  readManifest,
  sharedVersion,
  uvProjectPaths,
  workspacePath,
} from './workspaces.ts';

const args = new Set(process.argv.slice(2));
const increments = (['patch', 'minor', 'major'] as const).filter(value => args.has(value));
if (increments.length > 1) throw new Error('Choose only one increment: patch, minor, or major.');
const knownArgs = new Set(['patch', 'minor', 'major', '--dry-run', '--initial', '--push']);
const unknownArgs = [...args].filter(value => !knownArgs.has(value));
if (unknownArgs.length > 0) throw new Error(`Unknown release argument: ${unknownArgs.join(', ')}.`);

const increment: ReleaseIncrement = increments[0] ?? 'patch';
const dryRun = args.has('--dry-run');
const initial = args.has('--initial');
const push = args.has('--push');
const remote = 'origin';
const releaseBranch = 'main';
const uvProjects = await uvProjectPaths();
const generatedVersionFiles = (await Promise.all(WORKSPACES.map(async workspace =>
  (await generatedPackageVersionPaths(workspacePath(workspace)))
    .map(file => `${workspace.path}/${file}`)
))).flat();
const generatedPythonVersionFiles = (await Promise.all(PYTHON_PROJECTS.map(async project =>
  (await generatedPackageVersionPaths(path.join(ROOT, project.path)))
    .map(file => project.path === '.' ? file : `${project.path}/${file}`)
))).flat();
const versionFiles = [
  VERSION_FILE,
  'package.json',
  'bun.lock',
  ...BUN_WORKSPACES.map(workspace => `${workspace.path}/package.json`),
  ...generatedVersionFiles,
  ...generatedPythonVersionFiles,
  ...uvProjects.map(project => project === '.' ? 'uv.lock' : `${project}/uv.lock`),
] as const;
const snapshots = new Map<string, { readonly content: Buffer; readonly mode: number }>();
for (const filename of versionFiles) {
  const absolutePath = path.join(ROOT, filename);
  const [content, metadata] = await Promise.all([readFile(absolutePath), stat(absolutePath)]);
  snapshots.set(filename, { content, mode: metadata.mode & 0o777 });
}
let releaseHistoryCreated = false;
let pushed = false;
let versionChanged = false;
let workspaceSnapshot: WorkspaceSnapshot | undefined;
const initialStatus = await workspaceStatus(ROOT);

try {
  if (initialStatus && !push) {
    throw new Error('Release requires a clean worktree unless --push is provided.');
  }
  await assertGitOperationSafe(ROOT);
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
  const [localHead, upstream, upstreamHead, remoteHeads] = await Promise.all([
    git(['rev-parse', 'HEAD']),
    git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
    git(['rev-parse', '@{upstream}']),
    git(['ls-remote', '--heads', remote, `refs/heads/${releaseBranch}`]),
  ]);
  if (upstream !== `${remote}/${releaseBranch}`) {
    throw new Error(`${releaseBranch} must track ${remote}/${releaseBranch}, not ${upstream}.`);
  }
  const remoteHead = remoteHeads.split(/\s+/u)[0];
  if (!remoteHead) throw new Error(`Could not resolve ${remote}/${releaseBranch}.`);
  const mergeBase = await git(['merge-base', localHead, remoteHead]);
  assertReleaseBranchState({
    allowPush: push,
    branch: releaseBranch,
    localHead,
    mergeBase,
    remoteHead,
    upstreamHead,
  });

  if (initialStatus) {
    workspaceSnapshot = await commitWorkspace(ROOT, localHead);
  }
  await assertCleanWorkspace(ROOT);

  const remoteTags = await git(['ls-remote', '--tags', '--refs', remote]);
  const currentVersion = await sharedVersion();
  const plan = planRelease({
    increment,
    initial,
    latestRemoteVersion: latestReleaseVersion(remoteTags),
    sourceVersion: currentVersion,
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
  for (const project of PYTHON_DISTRIBUTIONS) {
    const response = await fetch(pypiVersionUrl(project.name, plan.nextVersion), {
      redirect: 'error',
    });
    if (response.ok) throw new Error(`${project.name}==${plan.nextVersion} already exists on PyPI.`);
    if (response.status !== 404) {
      throw new Error(
        `Could not verify ${project.name}==${plan.nextVersion} on PyPI: HTTP ${response.status}.`,
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

  await runBun(['.projenrc.ts'], {
    cwd: ROOT,
    env: { PROJEN_DISABLE_POST: 'true' },
    inherit: true,
  });
  await runBun(['install'], { cwd: ROOT, inherit: true });
  for (const project of uvProjects) {
    await runCommand('uv', ['lock', '--project', project], { cwd: ROOT, inherit: true });
  }
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
      releaseHistoryCreated = true;
    }

    await git(['tag', tag]);
    releaseHistoryCreated = true;
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
  if (workspaceSnapshot && !releaseHistoryCreated && !pushed) {
    try {
      await restoreWorkspaceSnapshot(ROOT, workspaceSnapshot);
      workspaceSnapshot = undefined;
      versionChanged = false;
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Release failed and the original worktree could not be restored automatically.',
      );
    }
  }
  if (releaseHistoryCreated && !pushed) {
    console.error('Release history exists locally; inspect the commit and tag before retrying the push.');
  }
  throw error;
} finally {
  if (versionChanged && !workspaceSnapshot && (dryRun || (!releaseHistoryCreated && !pushed))) {
    await restoreManagedVersionFiles();
  }
  if (workspaceSnapshot) {
    if (dryRun && !releaseHistoryCreated && !pushed) {
      await restoreWorkspaceSnapshot(ROOT, workspaceSnapshot);
      workspaceSnapshot = undefined;
      versionChanged = false;
    } else if (pushed || releaseHistoryCreated) {
      try {
        await dropWorkspaceSnapshot(ROOT, workspaceSnapshot);
      } catch (error) {
        console.warn(`Release history was preserved, but its worktree snapshot remains: ${String(error)}`);
      }
    }
  }
}

if (dryRun && await workspaceStatus(ROOT) !== initialStatus) {
  throw new Error('Dry run did not restore the original worktree and staging state.');
}

async function updateSharedVersion(version: string): Promise<void> {
  await writeFile(path.join(ROOT, VERSION_FILE), `${version}\n`, 'utf8');
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

async function restoreManagedVersionFiles(): Promise<void> {
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
