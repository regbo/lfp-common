import path from 'node:path';
import { createFileSystemProject, type Workspace } from 'pacwich';
import { parse } from 'smol-toml';

export const ROOT = path.resolve(import.meta.dir, '..');
const pythonPackagePaths = [...new Bun.Glob('packages/py/*/pyproject.toml').scanSync({
  cwd: ROOT,
  onlyFiles: true,
})].map(file => path.dirname(file).replaceAll('\\', '/')).sort();
export const PYTHON_PROJECTS = await Promise.all(['.', ...pythonPackagePaths].map(async projectPath => {
  const pyproject = parse(await Bun.file(path.join(ROOT, projectPath, 'pyproject.toml')).text()) as {
    readonly project?: { readonly name?: unknown };
  };
  if (typeof pyproject.project?.name !== 'string') {
    throw new Error(`${projectPath}/pyproject.toml has no project name.`);
  }
  const tasksFile = Bun.file(path.join(ROOT, projectPath, '.projen', 'tasks.json'));
  const tasks = await tasksFile.exists()
    ? await tasksFile.json() as { readonly tasks?: Readonly<Record<string, unknown>> }
    : undefined;
  return {
    name: pyproject.project.name,
    path: projectPath,
    publish: tasks?.tasks?.publish !== undefined,
  };
}));
export const PYTHON_DISTRIBUTIONS = PYTHON_PROJECTS.filter(project => project.publish);
export const BUN_WORKSPACES = createFileSystemProject({
  rootDirectory: ROOT,
  packageManager: 'bun',
  disableExecutableConfigs: true,
}).workspaces;
export const WORKSPACES = BUN_WORKSPACES.filter(workspace =>
  workspace.path.replaceAll('\\', '/').startsWith('packages/js/')
);

export function workspacePath(workspace: Workspace): string {
  return path.join(ROOT, workspace.path);
}

export function readManifest(directory: string) {
  return Bun.file(path.join(directory, 'package.json')).json();
}

export function pypiVersionUrl(distribution: string, version: string): string {
  return `https://pypi.org/pypi/${encodeURIComponent(distribution)}/${encodeURIComponent(version)}/json`;
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

export async function uvProjectPaths(): Promise<readonly string[]> {
  const hasWorkspace = await Bun.file(path.join(ROOT, 'pyproject.toml')).exists();
  const hasLock = await Bun.file(path.join(ROOT, 'uv.lock')).exists();
  return hasWorkspace && hasLock ? ['.'] : [];
}

export async function sharedVersion(): Promise<string> {
  const version = (await readManifest(ROOT)).version;
  if (typeof version !== 'string') throw new Error('Root package.json has no version.');

  const mismatches = (await Promise.all(BUN_WORKSPACES.map(async workspace => ({
    name: workspace.name,
    version: (await readManifest(workspacePath(workspace))).version,
  })))).filter(workspace => workspace.version !== version);
  if (mismatches.length > 0) {
    throw new Error(
      `Workspace versions must equal root ${version}: ` +
      mismatches.map(workspace => `${workspace.name}@${workspace.version}`).join(', '),
    );
  }

  const pythonMismatches = (await Promise.all(PYTHON_PROJECTS.map(async project => ({
    ...project,
    version: ((await Bun.file(path.join(ROOT, project.path, 'pyproject.toml')).text())
      .match(/^version\s*=\s*"([^"]+)"/mu)?.[1]),
  })))).filter(project => project.version !== version);
  if (pythonMismatches.length > 0) {
    throw new Error(
      `Python project versions must equal root ${version}: ` +
      pythonMismatches.map(project => `${project.name}@${project.version ?? '<missing>'}`).join(', '),
    );
  }
  return version;
}
