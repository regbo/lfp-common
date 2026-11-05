import { stat } from 'node:fs/promises';
import path from 'node:path';
import { runCommand } from './process.ts';

export interface WorkspaceSnapshot {
  readonly head: string;
  readonly stash: string;
}

/** Reject repository states that cannot be safely collapsed into a preparation commit. */
export async function assertGitOperationSafe(root: string): Promise<void> {
  const unmerged = await git(root, ['diff', '--name-only', '--diff-filter=U']);
  if (unmerged) throw new Error(`Release cannot commit unmerged files: ${unmerged.replaceAll('\n', ', ')}.`);

  const markers = [
    ['merge', 'MERGE_HEAD'],
    ['cherry-pick', 'CHERRY_PICK_HEAD'],
    ['revert', 'REVERT_HEAD'],
    ['rebase', 'rebase-merge'],
    ['rebase', 'rebase-apply'],
    ['sequencer', 'sequencer'],
    ['bisect', 'BISECT_LOG'],
  ] as const;
  for (const [operation, marker] of markers) {
    const gitPath = await git(root, ['rev-parse', '--git-path', marker]);
    const absolutePath = path.isAbsolute(gitPath) ? gitPath : path.join(root, gitPath);
    if (await pathExists(absolutePath)) {
      throw new Error(`Release cannot commit while a Git ${operation} operation is in progress.`);
    }
  }
}

/** Commit every worktree change while retaining a restorable copy of its original staging state. */
export async function commitWorkspace(root: string, head: string): Promise<WorkspaceSnapshot> {
  await git(root, [
    'stash',
    'push',
    '--include-untracked',
    '--message',
    `release --push snapshot ${process.pid}-${Date.now()}`,
  ]);
  const snapshot = { head, stash: await git(root, ['rev-parse', 'refs/stash']) };
  try {
    await git(root, ['stash', 'apply', '--index', snapshot.stash]);
    await git(root, ['add', '--all']);
    if (!await git(root, ['diff', '--cached', '--name-only'])) {
      throw new Error('--push found worktree changes but nothing that Git can commit.');
    }
    await runCommand('git', ['commit', '-m', 'chore: prepare release'], {
      cwd: root,
      inherit: true,
    });
    await assertCleanWorkspace(root);
    return snapshot;
  } catch (error) {
    try {
      await restoreWorkspaceSnapshot(root, snapshot);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Could not create the preparation commit or restore the original worktree.',
      );
    }
    throw error;
  }
}

/** Restore the exact tracked, staged, and untracked state captured before preparation. */
export async function restoreWorkspaceSnapshot(
  root: string,
  snapshot: WorkspaceSnapshot,
): Promise<void> {
  await git(root, ['reset', '--hard', snapshot.head]);
  if (await workspaceStatus(root)) {
    await git(root, [
      'stash',
      'push',
      '--include-untracked',
      '--message',
      `failed release cleanup ${process.pid}-${Date.now()}`,
    ]);
    const cleanup = await git(root, ['rev-parse', 'refs/stash']);
    if (cleanup !== snapshot.stash) await dropStash(root, cleanup);
  }
  await git(root, ['stash', 'apply', '--index', snapshot.stash]);
  await dropWorkspaceSnapshot(root, snapshot);
}

export function dropWorkspaceSnapshot(root: string, snapshot: WorkspaceSnapshot): Promise<void> {
  return dropStash(root, snapshot.stash);
}

export async function assertCleanWorkspace(root: string): Promise<void> {
  if (await workspaceStatus(root)) throw new Error('Release requires a clean worktree.');
}

export function workspaceStatus(root: string): Promise<string> {
  return git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
}

async function dropStash(root: string, stash: string): Promise<void> {
  const entries = (await git(root, ['stash', 'list', '--format=%H'])).split(/\r?\n/u).filter(Boolean);
  const index = entries.indexOf(stash);
  if (index >= 0) await git(root, ['stash', 'drop', `stash@{${index}}`]);
}

async function pathExists(filename: string): Promise<boolean> {
  try {
    await stat(filename);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function git(root: string, args: readonly string[]): Promise<string> {
  return runCommand('git', args, { cwd: root });
}
