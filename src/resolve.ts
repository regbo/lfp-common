import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Resolve a package from an explicit package root without importing it. */
export function resolvePackage(packageName: string, packageRoot: string): string | undefined {
  const resolver = createRequire(path.join(path.resolve(packageRoot), 'package.json'));
  try {
    return resolver.resolve(packageName);
  } catch (error) {
    if (isMissingModule(error)) return undefined;
    throw error;
  }
}

/** Import a package only when it is already resolvable from the supplied package root. */
export async function importPackageIfAvailable<Module = unknown>(
  packageName: string,
  packageRoot: string,
): Promise<Module | undefined> {
  const resolved = resolvePackage(packageName, packageRoot);
  if (!resolved) return undefined;
  return import(pathToFileURL(resolved).href) as Promise<Module>;
}

function isMissingModule(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'MODULE_NOT_FOUND';
}
