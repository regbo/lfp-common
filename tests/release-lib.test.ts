import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCommand } from '../scripts/process.ts';
import {
  assertGitOperationSafe,
  commitWorkspace,
  restoreWorkspaceSnapshot,
  workspaceStatus,
} from '../scripts/release-git.ts';
import {
  assertReleaseBranchState,
  githubRepositoryFromRemote,
  incrementVersion,
  isPublicGitHubIdentity,
  latestReleaseVersion,
  planRelease,
} from '../scripts/release-lib.ts';
import { readRootVersion, VERSION_FILE } from '../scripts/version.ts';

describe('root version source', () => {
  test('reads one stable semantic version from VERSION', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lfp-version-'));
    try {
      await writeFile(path.join(root, VERSION_FILE), '1.2.3\n');
      expect(readRootVersion(root)).toBe('1.2.3');
      await writeFile(path.join(root, VERSION_FILE), '1.2.3-beta.1\n');
      expect(() => readRootVersion(root)).toThrow('stable semantic version');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe('release worktree transaction', () => {
  test('commits every change and restores the original staging state', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lfp-release-'));
    try {
      await git(root, ['init', '--quiet']);
      await git(root, ['config', 'user.name', 'Release Test']);
      await git(root, ['config', 'user.email', 'release-test@users.noreply.github.com']);
      await writeFile(path.join(root, 'tracked.txt'), 'base\n');
      await git(root, ['add', 'tracked.txt']);
      await git(root, ['commit', '--quiet', '-m', 'initial']);
      const head = await git(root, ['rev-parse', 'HEAD']);

      await writeFile(path.join(root, 'tracked.txt'), 'staged\n');
      await git(root, ['add', 'tracked.txt']);
      await writeFile(path.join(root, 'tracked.txt'), 'staged\nunstaged\n');
      await writeFile(path.join(root, 'untracked.txt'), 'untracked\n');
      const status = await workspaceStatus(root);

      const snapshot = await commitWorkspace(root, head);
      expect(await workspaceStatus(root)).toBe('');
      expect(await git(root, ['show', '--format=', '--name-only', 'HEAD'])).toContain('untracked.txt');

      await writeFile(path.join(root, 'release.tmp'), 'release debris\n');
      await restoreWorkspaceSnapshot(root, snapshot);

      expect(await git(root, ['rev-parse', 'HEAD'])).toBe(head);
      expect(await workspaceStatus(root)).toBe(status);
      expect(await git(root, ['show', ':tracked.txt'])).toBe('staged');
      expect(await readFile(path.join(root, 'tracked.txt'), 'utf8')).toBe('staged\nunstaged\n');
      expect(await readFile(path.join(root, 'untracked.txt'), 'utf8')).toBe('untracked\n');
      expect(await git(root, ['stash', 'list', '--format=%H'])).not.toContain(snapshot.stash);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test('refuses an in-progress Git operation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lfp-release-'));
    try {
      await git(root, ['init', '--quiet']);
      const mergeHead = await git(root, ['rev-parse', '--git-path', 'MERGE_HEAD']);
      await writeFile(path.resolve(root, mergeHead), 'in progress\n');
      await expect(assertGitOperationSafe(root)).rejects.toThrow('merge operation is in progress');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe('release branch safety', () => {
  const remoteHead = 'remote';

  test('requires exact synchronization by default', () => {
    expect(() => assertReleaseBranchState({
      allowPush: false,
      branch: 'main',
      localHead: 'local',
      mergeBase: remoteHead,
      remoteHead,
      upstreamHead: remoteHead,
    })).toThrow('must exactly match');
  });

  test('allows a conflict-free local fast-forward with --push', () => {
    expect(() => assertReleaseBranchState({
      allowPush: true,
      branch: 'main',
      localHead: 'local',
      mergeBase: remoteHead,
      remoteHead,
      upstreamHead: remoteHead,
    })).not.toThrow();
  });

  test('rejects a behind or diverged branch with --push', () => {
    expect(() => assertReleaseBranchState({
      allowPush: true,
      branch: 'main',
      localHead: 'local',
      mergeBase: 'older',
      remoteHead,
      upstreamHead: remoteHead,
    })).toThrow('without overwriting or merging');
  });
});

describe('release version planning', () => {
  test('selects the greatest valid remote tag', () => {
    expect(latestReleaseVersion([
      'aaa\trefs/tags/v0.8.2',
      'bbb\trefs/tags/not-a-release',
      'ccc\trefs/tags/v0.10.0',
      'ddd\trefs/tags/v0.9.7',
    ].join('\n'))).toBe('0.10.0');
  });

  test('increments stable versions', () => {
    expect(incrementVersion('1.2.3', 'patch')).toBe('1.2.4');
    expect(incrementVersion('1.2.3', 'minor')).toBe('1.3.0');
    expect(incrementVersion('1.2.3', 'major')).toBe('2.0.0');
  });

  test('keeps the configured version for an explicit initial release', () => {
    expect(planRelease({
      increment: 'patch',
      initial: true,
      sourceVersion: '0.8.0',
    })).toEqual({ initial: true, nextVersion: '0.8.0' });
  });
});
describe('public GitHub repository and identity checks', () => {
  test('accepts supported remote forms', () => {
    expect(githubRepositoryFromRemote('git@github.com:regbo/lfp-common.git')).toBe('regbo/lfp-common');
    expect(githubRepositoryFromRemote('https://github.com/regbo/lfp-common.git')).toBe('regbo/lfp-common');
    expect(githubRepositoryFromRemote('ssh://git@github.com/regbo/lfp-common.git')).toBe('regbo/lfp-common');
  });

  test('requires a GitHub noreply identity', () => {
    expect(isPublicGitHubIdentity('123+regbo@users.noreply.github.com')).toBeTrue();
    expect(isPublicGitHubIdentity('personal@example.com')).toBeFalse();
  });
});

function git(root: string, args: readonly string[]): Promise<string> {
  return runCommand('git', args, { cwd: root });
}
