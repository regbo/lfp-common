import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

test('keeps install-pkg as the only runtime dependency', async () => {
  const manifest = JSON.parse(
    await readFile(path.resolve(import.meta.dir, '..', 'package.json'), 'utf8'),
  ) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };

  expect(manifest.dependencies).toEqual({ '@antfu/install-pkg': '^2.1.0' });
  expect(manifest.devDependencies).not.toHaveProperty('commander');
  expect(manifest.peerDependenciesMeta).toEqual({
    fireargs: { optional: true },
    zod: { optional: true },
  });
  expect(manifest.peerDependencies?.fireargs).toBe(manifest.devDependencies?.fireargs);
  expect(manifest.peerDependencies?.zod).toBe(manifest.devDependencies?.zod);
});
