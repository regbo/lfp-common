import { rm } from 'node:fs/promises';
import path from 'node:path';
import './generate-catalog.ts';

const root = path.resolve(import.meta.dirname, '..');
const distribution = path.join(root, 'dist');
if (path.dirname(distribution) !== root || path.basename(distribution) !== 'dist') {
  throw new Error(`Refusing to clean an unexpected build directory: ${distribution}`);
}

// TypeScript does not remove outputs whose source files were renamed or deleted.
await rm(distribution, { recursive: true, force: true });
const result = Bun.spawnSync([process.execPath, 'x', 'tsc', '-p', 'tsconfig.json'], {
  cwd: root,
  stderr: 'inherit',
  stdout: 'inherit',
});
if (result.exitCode !== 0) throw new Error('TypeScript build failed.');
