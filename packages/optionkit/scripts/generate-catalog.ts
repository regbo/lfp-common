import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const monorepoRoot = path.resolve(root, '..', '..');
const manifest = JSON.parse(
  await readFile(path.join(root, 'package.json'), 'utf8'),
) as {
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};
const monorepo = JSON.parse(
  await readFile(path.join(monorepoRoot, 'package.json'), 'utf8'),
) as {
  workspaces?: { catalog?: Record<string, string> };
};
const catalog = monorepo.workspaces?.catalog;
if (!catalog) throw new Error('The monorepo package.json must define a workspace catalog.');

const cliPackages = ['clean-stack', 'fireargs', 'zod'] as const;
for (const name of cliPackages) {
  if (manifest.devDependencies?.[name] !== 'catalog:') {
    throw new Error(`${name} must use catalog: in devDependencies.`);
  }
  if (manifest.peerDependencies?.[name] !== undefined &&
      manifest.peerDependencies[name] !== 'catalog:') {
    throw new Error(`${name} must use catalog: in peerDependencies.`);
  }
}

const generatedDirectory = path.join(root, 'src', '_generated');
const generated = Object.fromEntries(cliPackages.map(name => [name, catalog[name]]));
if (Object.values(generated).some(value => value === undefined)) {
  throw new Error('The monorepo catalog is missing an Optionkit CLI dependency.');
}
const output = `// Generated from the monorepo catalog by scripts/generate-catalog.ts.\n` +
  `export const catalog = ${JSON.stringify(generated, null, 2)} as const;\n`;
await mkdir(generatedDirectory, { recursive: true });
await writeFile(path.join(generatedDirectory, 'catalog.ts'), output, 'utf8');
