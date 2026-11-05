import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importPackageIfAvailable, resolvePackage } from '../src/resolve.ts';

const root = path.resolve(import.meta.dir, '..');

test('resolves and imports an available package from an explicit root', async () => {
  expect(resolvePackage('fireargs', root)).toContain('fireargs');
  const fireargs = await importPackageIfAvailable<typeof import('fireargs')>('fireargs', root);
  expect(fireargs?.f).toBeDefined();
});

test('returns undefined when a package is unavailable', async () => {
  expect(resolvePackage('optionkit-package-that-does-not-exist', root)).toBeUndefined();
  expect(
    await importPackageIfAvailable('optionkit-package-that-does-not-exist', root),
  ).toBeUndefined();
});

test('resolves a package installed after an initial cached miss', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'optionkit-resolve-'));
  const packageRoot = path.join(fixture, 'node_modules', 'late-package');
  try {
    await writeFile(path.join(fixture, 'package.json'), '{"type":"module"}\n');
    expect(resolvePackage('late-package', fixture)).toBeUndefined();
    await mkdir(packageRoot, { recursive: true });
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: 'late-package',
      exports: './index.js',
      type: 'module',
    }));
    await writeFile(path.join(packageRoot, 'index.js'), 'export const ready = true;\n');

    expect(resolvePackage('late-package', fixture)).toBe(path.join(packageRoot, 'index.js'));
    expect(await importPackageIfAvailable<{ ready: boolean }>('late-package', fixture))
      .toEqual({ ready: true });
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
});
