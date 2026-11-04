import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const outdir = path.join(root, 'dist', 'cjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const result = await Bun.build({
  entrypoints: [
    path.join(root, 'src', 'index.ts'),
    path.join(root, 'src', '_generated', 'metadata.ts'),
  ],
  outdir,
  target: 'node',
  format: 'cjs',
  // Runtime dependencies remain external in both module formats.
  packages: 'external',
  sourcemap: 'external',
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
