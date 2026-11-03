import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import {
  assertAutoCommitCompatible,
  isPrivateGitHubEmail,
  isPyfigGitHubRemote,
  latestRemoteVersion,
  nextReleaseVersion,
  RELEASE_INCREMENTS,
  type ReleaseIncrement,
} from './release-utils.ts';
import { runBun, runCommand } from './command.ts';

interface PackageManifest {
  name: string;
  version: string;
}

const root = path.resolve(import.meta.dir, '..');
const manifestPath = path.join(root, 'package.json');

const program = new Command()
  .name('bun run release')
  .description('Verify, commit, tag, and push the next Pyfig release from GitHub SemVer tags.')
  .argument('[increment]', 'SemVer increment: major, minor, or patch', parseIncrement, 'patch')
  .option('--commit', 'verify, commit, and push compatible worktree changes before releasing')
  .option('--dry-run', 'verify the next release without committing, tagging, or pushing')
  .showHelpAfterError()
  .parse();

const increment = program.processedArgs[0] as ReleaseIncrement;
const { commit, dryRun } = program.opts<{ commit: boolean; dryRun: boolean }>();
if (commit && dryRun) program.error('--commit cannot be combined with --dry-run');

try {
  await release(increment, dryRun, commit);
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`Release failed: ${detail}`);
  process.exitCode = 1;
}

async function release(
  releaseIncrement: ReleaseIncrement,
  isDryRun: boolean,
  shouldCommit: boolean,
): Promise<void> {
  assertReleaseIdentity();

  const remoteUrl = captureGit(['remote', 'get-url', 'origin']);
  if (!isPyfigGitHubRemote(remoteUrl)) {
    throw new Error(`origin must be the regbo/pyfig GitHub repository, received ${remoteUrl}.`);
  }

  if (captureGit(['branch', '--show-current']) !== 'main') {
    throw new Error('Releases must be created from the main branch.');
  }
  assertNoGitOperation();
  if (shouldCommit) await commitCompatibleChanges();
  else assertCleanWorkspace();

  runGit(['fetch', '--prune', '--tags', 'origin', 'main']);
  assertCleanWorkspace();
  if (captureGit(['rev-parse', 'HEAD']) !== captureGit(['rev-parse', 'origin/main'])) {
    throw new Error('Local main must exactly match origin/main before releasing.');
  }

  // Read tags from the remote itself so stale or private local tags cannot
  // influence the next public version.
  const remoteTags = captureGit(['ls-remote', '--tags', '--refs', 'origin', 'v*']);
  const latestVersion = latestRemoteVersion(remoteTags);
  const nextVersion = nextReleaseVersion(latestVersion, releaseIncrement);
  const nextTag = `v${nextVersion}`;
  if (captureGit(['tag', '--list', nextTag])) {
    throw new Error(`Local tag ${nextTag} already exists.`);
  }

  const originalManifest = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(originalManifest) as PackageManifest;
  if (manifest.version !== latestVersion) {
    throw new Error(
      `package.json version ${manifest.version} must match the latest GitHub tag v${latestVersion}.`,
    );
  }

  manifest.version = nextVersion;
  let manifestChanged = false;
  let releaseCommitted = false;
  let temporaryDirectory: string | undefined;
  console.log(`Preparing ${manifest.name}@${nextVersion} from v${latestVersion} (${releaseIncrement}).`);

  try {
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    manifestChanged = true;

    runBun(['run', 'release:check', '--', nextTag], { cwd: root });
    runBun(['run', 'verify'], { cwd: root });
    runBun(['run', 'build'], { cwd: root });

    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'pyfig-release-'));
    runBun([
      'pm', 'pack',
      '--ignore-scripts',
      '--destination', temporaryDirectory,
      '--quiet',
    ], { cwd: root });
    const archives = (await readdir(temporaryDirectory))
      .filter(name => name.endsWith('.tgz'));
    if (archives.length !== 1 || !archives[0]) {
      throw new Error(`Expected exactly one release archive, found ${archives.length}.`);
    }
    const archive = path.join(temporaryDirectory, archives[0]);
    runBun(['run', 'release:audit', '--', archive], { cwd: root });

    if (isDryRun) {
      console.log(`Dry run passed for ${nextTag}; package.json will be restored.`);
      return;
    }

    runGit(['add', '--', 'package.json']);
    runGit(['commit', '-m', `release: ${nextTag}`]);
    releaseCommitted = true;
    runGit(['tag', nextTag]);
    runGit(['push', '--atomic', 'origin', 'main', `refs/tags/${nextTag}`]);
    console.log(`Released ${nextTag}; the trusted publishing workflow can now publish it.`);
  } finally {
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(error => {
        console.warn(`Could not remove temporary release directory: ${String(error)}`);
      });
    }
    if (manifestChanged && (isDryRun || !releaseCommitted)) {
      const staged = captureGit(['diff', '--cached', '--name-only', '--', 'package.json']);
      if (staged) runGit(['restore', '--staged', '--', 'package.json']);
      await writeFile(manifestPath, originalManifest, 'utf8');
    }
  }
}

async function commitCompatibleChanges(): Promise<void> {
  runGit(['fetch', '--prune', 'origin', 'main']);
  if (captureGit(['rev-parse', 'HEAD']) !== captureGit(['rev-parse', 'origin/main'])) {
    throw new Error('Local main must exactly match origin/main before auto-committing changes.');
  }

  const status = captureGit(['status', '--porcelain=v1', '--untracked-files=all']);
  const entries = assertAutoCommitCompatible(status);
  if (entries.length === 0) return;

  runBun(['run', 'verify'], { cwd: root });
  runGit(['add', '--all', '--', '.']);
  runGit(['commit', '-m', 'chore: prepare release']);
  runGit(['push', 'origin', 'main']);
  console.log(`Committed and pushed ${entries.length} compatible worktree change(s).`);
}

function parseIncrement(value: string): ReleaseIncrement {
  if (RELEASE_INCREMENTS.includes(value as ReleaseIncrement)) return value as ReleaseIncrement;
  throw new InvalidArgumentError('expected major, minor, or patch');
}

function assertCleanWorkspace(): void {
  if (captureGit(['status', '--porcelain=v1', '--untracked-files=all'])) {
    throw new Error('The worktree must be clean before releasing.');
  }
}

function assertNoGitOperation(): void {
  const gitDirectory = captureGit(['rev-parse', '--git-dir']);
  const inProgress = [
    'CHERRY_PICK_HEAD',
    'MERGE_HEAD',
    'REBASE_HEAD',
    'rebase-apply',
    'rebase-merge',
    'REVERT_HEAD',
  ].find(name => existsSync(path.resolve(root, gitDirectory, name)));
  if (inProgress) throw new Error(`Cannot release while Git operation ${inProgress} is in progress.`);
}

function assertReleaseIdentity(): void {
  const email = captureGit(['config', '--get', 'user.email']);
  if (!isPrivateGitHubEmail(email)) {
    throw new Error('git user.email must be a GitHub noreply address before a public release commit.');
  }
}

function runGit(args: string[]): void {
  runCommand('git', args, { cwd: root });
}

function captureGit(args: string[]): string {
  return runCommand('git', args, { capture: true, cwd: root });
}
