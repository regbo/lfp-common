import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

export interface PythonPackageLocation {
  readonly editable: boolean;
  readonly requirement: string;
}

/** Resolve the built worker wheel, falling back to the editable source project. */
export function resolvePythonPackage(moduleDirectory: string): PythonPackageLocation {
  const wheelDirectory = path.resolve(moduleDirectory, 'py');
  if (existsSync(wheelDirectory)) {
    const wheel = readdirSync(wheelDirectory)
      .filter(name => /^pynect_worker-.*\.whl$/u.test(name))
      .sort()
      .at(-1);
    if (wheel) {
      return Object.freeze({
        editable: false,
        requirement: path.join(wheelDirectory, wheel),
      });
    }
  }

  const sourceProject = path.resolve(moduleDirectory, '..', '..', '..', 'py', 'pynect-worker');
  if (existsSync(path.join(sourceProject, 'pyproject.toml'))) {
    return Object.freeze({ editable: true, requirement: sourceProject });
  }
  throw new Error('Could not locate the bundled pynect-worker wheel.');
}
