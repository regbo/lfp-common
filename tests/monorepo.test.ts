import { expect, test } from 'bun:test';
import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ROOT,
  BUN_WORKSPACES,
  PYTHON_DISTRIBUTIONS,
  PYTHON_PROJECTS,
  WORKSPACES,
  generatedMetadataPath,
  generatedPackageVersionPaths,
  readManifest,
  uvProjectPaths,
  workspacePath,
} from '../scripts/workspaces.ts';

const internalPackages = new Set<string>(BUN_WORKSPACES.map(workspace => workspace.name));

test('keeps one version, lockfile, catalog, and workspace protocol', async () => {
  const root = await readManifest(ROOT);

  for (const workspace of WORKSPACES) {
    const directory = workspacePath(workspace);
    const manifest = await readManifest(directory);
    expect(manifest.name).toBe(path.basename(directory));
    expect(manifest.version).toBe(root.version);
    expect(manifest.exports?.['./metadata']?.types).toEndWith('/_generated/metadata.d.ts');
    expect(manifest.exports?.['./metadata']?.import).toEndWith('/_generated/metadata.js');

    const metadataSource = await generatedMetadataPath(directory);
    const metadataPath = path.join(directory, metadataSource);
    const metadata = await readFile(metadataPath, 'utf8');
    expect(metadata).toContain(`export const PACKAGE_NAME = ${JSON.stringify(workspace.name)} as const;`);
    expect(metadata).toContain(`export const PACKAGE_VERSION = ${JSON.stringify(root.version)} as const;`);

    const generatedFiles = await Bun.file(path.join(directory, '.projen/files.json')).json();
    expect(generatedFiles.files).toContain(metadataSource);
    for (const versionFile of await generatedPackageVersionPaths(directory)) {
      const content = await readFile(path.join(directory, versionFile), 'utf8');
      expect(content).toContain(root.version);
    }

    for (const section of [
      manifest.dependencies,
      manifest.devDependencies,
      manifest.optionalDependencies,
      manifest.peerDependencies,
    ]) {
      for (const [name, specifier] of Object.entries(section ?? {})) {
        expect(specifier).toBe(internalPackages.has(name) ? 'workspace:*' : 'catalog:');
      }
    }

    await expect(access(path.join(directory, 'bun.lock'))).rejects.toThrow();
  }

  for (const workspace of BUN_WORKSPACES.filter(candidate => !WORKSPACES.includes(candidate))) {
    const directory = workspacePath(workspace);
    const manifest = await readManifest(directory);
    expect(manifest.name).toBe(path.basename(directory));
    expect(manifest.version).toBe(root.version);
    expect(manifest.private).toBe(true);
    for (const [name, specifier] of Object.entries(manifest.dependencies ?? {})) {
      expect(specifier).toBe(internalPackages.has(name) ? 'workspace:*' : 'catalog:');
    }
  }

  await access(path.join(ROOT, 'bun.lock'));

  for (const project of PYTHON_PROJECTS) {
    const pyproject = await readFile(path.join(ROOT, project.path, 'pyproject.toml'), 'utf8');
    expect(project.name).toBe(path.basename(path.resolve(ROOT, project.path)));
    expect(pyproject).toContain(`name = ${JSON.stringify(project.name)}`);
    expect(pyproject).toContain(`version = ${JSON.stringify(root.version)}`);
    if (project.path !== '.') {
      await expect(access(path.join(ROOT, project.path, 'uv.lock'))).rejects.toThrow();
    }
  }
});

test('keeps every Projen-generated file read-only', async () => {
  const projectDirectories = [
    ROOT,
    ...BUN_WORKSPACES.map(workspace => workspacePath(workspace)),
    ...PYTHON_PROJECTS.map(project => path.join(ROOT, project.path)),
  ];

  for (const directory of projectDirectories) {
    const inventory = await Bun.file(path.join(directory, '.projen/files.json')).json();

    for (const file of inventory.files) {
      await expect(access(path.join(directory, file), constants.W_OK)).rejects.toThrow();
    }
  }
});

test('uses one uv workspace lockfile for every Python project', async () => {
  expect(await uvProjectPaths()).toEqual(['.']);
  expect(PYTHON_DISTRIBUTIONS.map(project => project.name)).toEqual(['pynect-worker']);
});
