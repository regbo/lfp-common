import { expect, test } from 'bun:test';
import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ROOT,
  WORKSPACES,
  generatedMetadataPath,
  generatedPackageVersionPaths,
  readManifest,
  workspacePath,
} from '../scripts/workspaces.ts';

const internalPackages = new Set<string>(WORKSPACES.map(workspace => workspace.name));

test('keeps one version, lockfile, catalog, and workspace protocol', async () => {
  const root = await readManifest(ROOT);

  for (const workspace of WORKSPACES) {
    const directory = workspacePath(workspace);
    const manifest = await readManifest(directory);
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

  await access(path.join(ROOT, 'bun.lock'));
});

test('keeps every Projen-generated file read-only', async () => {
  const projectDirectories = [
    ROOT,
    ...WORKSPACES.map(workspace => workspacePath(workspace)),
  ];

  for (const directory of projectDirectories) {
    const inventory = await Bun.file(path.join(directory, '.projen/files.json')).json();

    for (const file of inventory.files) {
      await expect(access(path.join(directory, file), constants.W_OK)).rejects.toThrow();
    }
  }
});
