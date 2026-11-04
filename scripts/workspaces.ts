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

export async function generatedMetadataPath(directory: string): Promise<string> {
  const matches = (await generatedPackageVersionPaths(directory)).filter(file =>
    file.endsWith('/_generated/metadata.ts')
  );
  if (matches.length !== 1) {
    throw new Error(`Expected one generated metadata module in ${directory}, found ${matches.length}.`);
  }
  return matches[0]!;
}

export async function generatedPackageVersionPaths(directory: string): Promise<readonly string[]> {
  const inventory = await Bun.file(path.join(directory, '.projen', 'files.json')).json() as {
    readonly files?: readonly string[];
  };
  return (inventory.files ?? []).filter(file =>
    file === 'pyproject.toml' || /\/_generated\/metadata\.(?:py|ts)$/u.test(file)
  );
}

export async function uvWorkspacePaths(): Promise<readonly string[]> {
  const projects = await Promise.all(WORKSPACES.map(async workspace => {
    const directory = workspacePath(workspace);
    const [hasProject, hasLockfile] = await Promise.all([
      Bun.file(path.join(directory, 'pyproject.toml')).exists(),
      Bun.file(path.join(directory, 'uv.lock')).exists(),
    ]);
    return hasProject && hasLockfile ? workspace.path : undefined;
  }));
  return projects.filter((project): project is string => project !== undefined);
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
