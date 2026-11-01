import fs from 'node:fs';
import path from 'node:path';

export const VIRTUAL_ENV_ROOT_NAME = path.join('node_modules', '.pyfig', 'venvs');

export function virtualEnvironmentRoot(projectRoot: string): string {
  return path.join(projectRoot, VIRTUAL_ENV_ROOT_NAME);
}

export function virtualEnvironmentDirectory(projectRoot: string, venvDirectory: string): string {
  return path.join(virtualEnvironmentRoot(projectRoot), venvDirectory);
}

/** Existing application environments are eligible for read-only reuse. */
export function externalVirtualEnvironmentDirectories(
  projectRoot: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const candidates = [env['VIRTUAL_ENV'], path.join(projectRoot, '.venv')]
    .filter((value): value is string => Boolean(value))
    .map((value) => path.resolve(value));
  return [...new Map(candidates.map((value) => [canonicalPath(value), value])).values()];
}

export function virtualEnvironmentPythonExecutable(virtualEnvironment: string): string {
  return path.join(
    virtualEnvironment,
    process.platform === 'win32' ? 'Scripts' : 'bin',
    process.platform === 'win32' ? 'python.exe' : 'python',
  );
}

/** Apply the environment changes that shell activation scripts make for child processes. */
export function activateVirtualEnvironment(
  env: NodeJS.ProcessEnv,
  virtualEnvironment: string,
  pythonExecutable: string,
): NodeJS.ProcessEnv {
  const activated = { ...env };
  const pathEntry = Object.keys(activated).find((key) => key.toUpperCase() === 'PATH');
  const existingPath = pathEntry ? activated[pathEntry] : undefined;
  for (const key of Object.keys(activated)) {
    const normalized = key.toUpperCase();
    if (normalized === 'PATH' || normalized === 'PYTHONHOME' || normalized === 'VIRTUAL_ENV') {
      delete activated[key];
    }
  }
  activated['PATH'] = [path.dirname(pythonExecutable), existingPath]
    .filter((value): value is string => Boolean(value))
    .join(path.delimiter);
  activated['VIRTUAL_ENV'] = virtualEnvironment;
  return activated;
}

export function pathsEqual(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right);
}

/** Canonicalize existing paths so symlink, junction, and filesystem casing aliases compare equally. */
export function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  let canonical = resolved;
  try {
    canonical = fs.realpathSync.native(resolved);
  } catch {
    // Paths being provisioned do not exist yet; the absolute spelling is the best stable key.
  }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}
