import { expect, test } from 'bun:test';
import path from 'node:path';
import { importPackageIfAvailable, resolvePackage } from '../src/index.ts';

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
