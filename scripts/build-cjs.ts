import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dir, '..');
const outdir = path.join(root, 'dist', 'cjs');
const runtimeDirectoryToken = '__PYFIG_CJS_DIRECTORY__';

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const result = await Bun.build({
  entrypoints: [
    path.join(root, 'src', 'index.ts'),
    path.join(root, 'src', 'sync-resolver.ts'),
  ],
  outdir,
  target: 'node',
  format: 'cjs',
  // Dependencies are declared in package.json and stay external so the two
  // CommonJS entry bundles do not contain duplicate package copies.
  packages: 'external',
  sourcemap: 'external',
  // Bun replaces `__dirname` and `import.meta.url` with build-machine paths
  // while bundling. A post-build rewrite preserves the consumer's directory.
  define: { PYFIG_CJS_DIRECTORY: JSON.stringify(runtimeDirectoryToken) },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error('Could not build the CommonJS distribution.');
}

const runtimeSourceUrl = pathToFileURL(
  path.join(root, 'src', 'runtime-files.ts'),
).href;
for (const name of ['index.js', 'sync-resolver.js']) {
  const file = path.join(outdir, name);
  const bundled = await readFile(file, 'utf8');
  const relocatable = bundled
    .replaceAll(JSON.stringify(runtimeDirectoryToken), '__dirname')
    .replaceAll(
      JSON.stringify(runtimeSourceUrl),
      'require("node:url").pathToFileURL(__filename).href',
    );
  assertRelocatable(relocatable, name);
  await writeFile(file, relocatable, 'utf8');
}

await writeFile(
  path.join(outdir, 'package.json'),
  `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`,
  'utf8',
);

function assertRelocatable(contents: string, name: string): void {
  const buildPaths = new Set([
    root,
    root.replaceAll('\\', '/'),
    JSON.stringify(root).slice(1, -1),
    pathToFileURL(root).href,
  ]);
  if (contents.includes(runtimeDirectoryToken) ||
      [...buildPaths].some(buildPath => contents.includes(buildPath))) {
    throw new Error(`${name} contains a build-machine path.`);
  }
}
