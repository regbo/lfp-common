import { readFile, writeFile } from 'node:fs/promises';
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

const packages = ['clean-stack', 'fireargs', 'zod'] as const;
const versions = Object.fromEntries(packages.map(name => {
  const developmentVersion = manifest.devDependencies?.[name];
  const peerVersion = manifest.peerDependencies?.[name];
  if (developmentVersion !== 'catalog:') {
    throw new Error(`${name} must use catalog: in devDependencies.`);
  }
  if (peerVersion !== undefined && peerVersion !== 'catalog:') {
    throw new Error(`${name} must use catalog: in peerDependencies.`);
  }
  const version = workspace.catalog?.[name];
  if (!version) throw new Error(`pnpm-workspace.yaml must catalog ${name}.`);
  if (manifest.catalog?.[name] !== version) {
    throw new Error(`${name} must use the same Bun and pnpm catalog range.`);
  }
  return [name, version];
})) as Record<(typeof packages)[number], string>;

const output = `// Generated from pnpm-workspace.yaml by scripts/generate-cli-dependencies.ts.\n` +
  `export const CLI_DEPENDENCY_VERSIONS = ${JSON.stringify(versions, null, 2)} as const;\n`;
await writeFile(
  path.join(root, 'src', 'cli-dependencies.generated.ts'),
  output,
  'utf8',
);
