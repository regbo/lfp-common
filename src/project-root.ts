import fs from 'node:fs';
import path from 'node:path';

/** Resolve the nearest Git worktree without interpreting project manifests. */
export function resolveProjectRoot(startDirectory: string = process.cwd()): string {
  const start = path.resolve(startDirectory);
  for (const directory of ancestors(start)) {
    if (fs.existsSync(path.join(directory, '.git'))) return directory;
  }
  return start;
}

function* ancestors(startDirectory: string): Generator<string> {
  let directory = startDirectory;
  while (true) {
    yield directory;
    const parent = path.dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}
