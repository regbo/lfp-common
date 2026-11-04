import { rm } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const distribution = path.join(root, 'dist');
const pythonProject = path.resolve(root, '../../py/pynect-worker');
if (path.dirname(distribution) !== root || path.basename(distribution) !== 'dist') {
  throw new Error(`Refusing to clean an unexpected build directory: ${distribution}`);
}

await rm(distribution, { recursive: true, force: true });
run([process.execPath, 'x', 'tsc', '-p', 'tsconfig.json']);
run(['uv', 'build', '--project', pythonProject, '--out-dir', 'dist/py']);
await rm(path.join(distribution, 'py', '.gitignore'), { force: true });

function run(command: readonly string[]): void {
  const result = Bun.spawnSync([...command], {
    cwd: root,
    stderr: 'inherit',
    stdout: 'inherit',
  });
  if (result.exitCode !== 0) {
    throw new Error(`${command[0] ?? 'Command'} exited with code ${result.exitCode}.`);
  }
}
