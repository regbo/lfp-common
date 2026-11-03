import path from 'node:path';
import { createFileSystemProject, type Workspace } from 'pacwich';

export const ROOT = path.resolve(import.meta.dir, '..');
export const WORKSPACES = createFileSystemProject({
  rootDirectory: ROOT,
  packageManager: 'bun',
  disableExecutableConfigs: true,
}).workspaces;

export function workspacePath(workspace: Workspace): string {
  return path.join(ROOT, workspace.path);
}

export function readManifest(directory: string) {
  return Bun.file(path.join(directory, 'package.json')).json();
}

export async function sharedVersion(): Promise<string> {
  const version = (await readManifest(ROOT)).version;
  if (typeof version !== 'string') throw new Error('Root package.json has no version.');

  const mismatches = (await Promise.all(WORKSPACES.map(async workspace => ({
    name: workspace.name,
    version: (await readManifest(workspacePath(workspace))).version,
  })))).filter(workspace => workspace.version !== version);
  if (mismatches.length > 0) {
    throw new Error(
      `Workspace versions must equal root ${version}: ` +
      mismatches.map(workspace => `${workspace.name}@${workspace.version}`).join(', '),
    );
  }
  return version;
}
