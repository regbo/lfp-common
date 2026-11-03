import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(
  await readFile(path.join(root, 'package.json'), 'utf8'),
) as {
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const packages = ['clean-stack', 'fireargs', 'zod'] as const;
const versions = Object.fromEntries(packages.map(name => {
  const developmentVersion = manifest.devDependencies?.[name];
  const peerVersion = manifest.peerDependencies?.[name];
  if (peerVersion && developmentVersion !== peerVersion) {
    throw new Error(`${name} must use the same peer and development range.`);
  }
  const version = peerVersion ?? developmentVersion;
  if (!version) throw new Error(`package.json must declare ${name} in devDependencies.`);
  return [name, version];
})) as Record<(typeof packages)[number], string>;

const output = `// Generated from package.json by scripts/generate-cli-dependencies.ts.\n` +
  `export const CLI_DEPENDENCY_VERSIONS = ${JSON.stringify(versions, null, 2)} as const;\n`;
await writeFile(
  path.join(root, 'src', 'cli-dependencies.generated.ts'),
  output,
  'utf8',
);
