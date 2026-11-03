import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { catalog } from '../src/_generated/catalog.ts';

test('keeps install-pkg as the only runtime dependency', async () => {
  const root = path.resolve(import.meta.dir, '..');
  const monorepoRoot = path.resolve(root, '..', '..');
  const manifest = JSON.parse(
    await readFile(path.join(root, 'package.json'), 'utf8'),
  ) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };
  const monorepo = JSON.parse(
    await readFile(path.join(monorepoRoot, 'package.json'), 'utf8'),
  ) as { workspaces?: { catalog?: Record<string, string> } };

  expect(manifest.dependencies).toEqual({ '@antfu/install-pkg': 'catalog:' });
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
  expect(monorepo.workspaces?.catalog?.['clean-stack']).toBe(catalog['clean-stack']);
  expect(monorepo.workspaces?.catalog?.fireargs).toBe(catalog.fireargs);
  expect(monorepo.workspaces?.catalog?.zod).toBe(catalog.zod);
});
