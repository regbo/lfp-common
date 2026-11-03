import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

test('keeps install-pkg as the only runtime dependency', async () => {
  const root = path.resolve(import.meta.dir, '..');
  const manifest = JSON.parse(
    await readFile(path.join(root, 'package.json'), 'utf8'),
  ) as {
    catalog?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };
  const workspace = Bun.YAML.parse(
    await readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8'),
  ) as { catalog?: Record<string, string> };

  expect(manifest.dependencies).toEqual({ '@antfu/install-pkg': '^2.1.0' });
  expect(manifest.devDependencies).not.toHaveProperty('commander');
  expect(manifest.peerDependenciesMeta).toEqual({
    fireargs: { optional: true },
    zod: { optional: true },
  });
  expect(manifest.devDependencies?.['clean-stack']).toBe('catalog:');
  expect(manifest.devDependencies?.fireargs).toBe('catalog:');
  expect(manifest.devDependencies?.zod).toBe('catalog:');
  expect(manifest.peerDependencies?.fireargs).toBe('catalog:');
  expect(manifest.peerDependencies?.zod).toBe('catalog:');
  expect(workspace.catalog).toEqual({
    'clean-stack': '^7.0.0',
    fireargs: '^0.6.2',
    zod: '^4.6.7',
  });
  expect(manifest.catalog).toEqual(workspace.catalog);
});
