import { existsSync } from 'node:fs';
import path from 'node:path';

/** Resolve a Python helper from either the published bundle or the source tree. */
export function resolvePythonScript(moduleDirectory: string, scriptName: string): string {
  const bundled = path.resolve(moduleDirectory, '..', 'py', scriptName);
  if (existsSync(bundled)) return bundled;
  return path.resolve(moduleDirectory, '..', 'scripts', scriptName);
}
