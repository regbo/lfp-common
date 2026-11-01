import fs from 'node:fs';
import path from 'node:path';
import { createFileSystemProject } from 'pacwich';

const PACKAGE_MANAGER_LOCKFILES = [
  'bun.lock',
  'bun.lockb',
  'npm-shrinkwrap.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
] as const;

const PYTHON_PROJECT_MARKERS = [
  'pyproject.toml',
  'uv.lock',
] as const;

/** Resolve the repository root from a working directory without requiring Git. */
export function resolveProjectRoot(startDirectory: string = process.cwd()): string {
  const start = path.resolve(startDirectory);
  const workspaceRoot = findWorkspaceProjectRoot(start);
  if (workspaceRoot) {
    try {
      return path.resolve(createFileSystemProject({
        rootDirectory: start,
        disableExecutableConfigs: true,
      }).rootDirectory);
    } catch {
      // Pacwich can reject an otherwise recognizable root when workspace metadata is incomplete.
      return workspaceRoot;
    }
  }

  return findConventionalProjectRoot(start);
}

function findWorkspaceProjectRoot(startDirectory: string): string | null {
  for (const directory of ancestors(startDirectory)) {
    const packageJson = path.join(directory, 'package.json');
    if (!fs.existsSync(packageJson)) continue;
    if (fs.existsSync(path.join(directory, 'pnpm-workspace.yaml'))) return directory;

    try {
      const manifest = JSON.parse(fs.readFileSync(packageJson, 'utf8')) as { workspaces?: unknown };
      if (hasWorkspaceDeclaration(manifest.workspaces)) return directory;
    } catch {
      // Keep walking so malformed nested package metadata cannot hide a valid ancestor.
    }
  }
  return null;
}

function findConventionalProjectRoot(startDirectory: string): string {
  let nearestPackageDirectory: string | null = null;
  let nearestPythonDirectory: string | null = null;
  for (const directory of ancestors(startDirectory)) {
    const hasPackage = fs.existsSync(path.join(directory, 'package.json'));
    if (hasPackage && !nearestPackageDirectory) nearestPackageDirectory = directory;
    if (!nearestPythonDirectory && PYTHON_PROJECT_MARKERS.some(
      (file) => fs.existsSync(path.join(directory, file)),
    )) {
      nearestPythonDirectory = directory;
    }
    if (hasPackage && PACKAGE_MANAGER_LOCKFILES.some((file) => fs.existsSync(path.join(directory, file)))) {
      return directory;
    }
    if (fs.existsSync(path.join(directory, '.git'))) return directory;
  }
  return nearestPackageDirectory ?? nearestPythonDirectory ?? startDirectory;
}

function hasWorkspaceDeclaration(value: unknown): boolean {
  return Array.isArray(value) || (value !== null && typeof value === 'object');
}

function* ancestors(startDirectory: string): Generator<string> {
  let directory = startDirectory;
  while (true) {
    yield directory;
    const parent = path.dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}
