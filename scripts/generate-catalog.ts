import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(
  await readFile(path.join(root, 'package.json'), 'utf8'),
) as {
  catalog?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};
const workspace = Bun.YAML.parse(
  await readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8'),
) as { catalog?: Record<string, string> };

if (!manifest.catalog) throw new Error('package.json must define a catalog.');
if (JSON.stringify(manifest.catalog) !== JSON.stringify(workspace.catalog)) {
  throw new Error('The Bun and pnpm catalogs must match exactly.');
}

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
const output = `// Generated from package.json by scripts/generate-catalog.ts.\n` +
  `export const catalog = ${JSON.stringify(manifest.catalog, null, 2)} as const;\n`;
await mkdir(generatedDirectory, { recursive: true });
await writeFile(path.join(generatedDirectory, 'catalog.ts'), output, 'utf8');
