import path from 'node:path';
import { createFileSystemProject, type Workspace } from 'pacwich';

export const ROOT = path.resolve(import.meta.dir, '..');
const PYTHON_PROJECT_PATHS = ['packages/py/pynect-worker'] as const;
export const PYTHON_DISTRIBUTIONS = PYTHON_PROJECT_PATHS.map(projectPath => ({
  name: path.posix.basename(projectPath),
  path: projectPath,
}));
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
  const projects: string[] = [];
  for (const pattern of ['packages/js/*/**/pyproject.toml', 'packages/py/*/pyproject.toml']) {
    const projectFiles = new Bun.Glob(pattern);
    for await (const projectFile of projectFiles.scan({
      cwd: ROOT,
      followSymlinks: false,
      onlyFiles: true,
    })) {
      const project = path.dirname(projectFile);
      const segments = project.split(/[\\/]/u);
      if (segments.includes('node_modules') || segments.includes('.venv')) continue;
      if (await Bun.file(path.join(ROOT, project, 'uv.lock')).exists()) {
        projects.push(project.split(path.sep).join('/'));
      }
    }
  }
  return [...new Set(projects)].sort();
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

  const pythonMismatches = (await Promise.all(PYTHON_DISTRIBUTIONS.map(async project => ({
    ...project,
    version: ((await Bun.file(path.join(ROOT, project.path, 'pyproject.toml')).text())
      .match(/^version\s*=\s*"([^"]+)"/mu)?.[1]),
  })))).filter(project => project.version !== version);
  if (pythonMismatches.length > 0) {
    throw new Error(
      `Python distribution versions must equal root ${version}: ` +
      pythonMismatches.map(project => `${project.name}@${project.version ?? '<missing>'}`).join(', '),
    );
  }
  return version;
}
