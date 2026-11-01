import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const outdir = path.join(root, 'dist', 'cjs');

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
  define: { PYFIG_CJS_DIRECTORY: '__dirname' },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error('Could not build the CommonJS distribution.');
}

await writeFile(
  path.join(outdir, 'package.json'),
  `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`,
  'utf8',
);
