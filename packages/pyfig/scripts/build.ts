import { rm } from 'node:fs/promises';
import path from 'node:path';
import { runBun } from './command.ts';

const root = path.resolve(import.meta.dir, '..');
const distribution = path.join(root, 'dist');
if (path.dirname(distribution) !== root || path.basename(distribution) !== 'dist') {
  throw new Error(`Refusing to clean an unexpected build directory: ${distribution}`);
}

// TypeScript does not remove outputs for renamed or deleted sources. Cleaning
// here keeps the published archive limited to artifacts from the current tree.
await rm(distribution, { recursive: true, force: true });
runBun(['x', 'tsc', '-p', 'tsconfig.json'], { cwd: root });
runBun(['run', 'scripts/build-cjs.ts'], { cwd: root });
