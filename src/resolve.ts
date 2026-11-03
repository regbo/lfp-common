import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Resolve a package from an explicit package root without importing it. */
export function resolvePackage(packageName: string, packageRoot: string): string | undefined {
  const resolver = createRequire(path.join(path.resolve(packageRoot), 'package.json'));
  try {
    return resolver.resolve(packageName);
  } catch (error) {
    if (isMissingModule(error)) return resolveInstalledPackage(packageName, packageRoot);
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

/** Bypass Node's cached miss after a package was installed during this process. */
function resolveInstalledPackage(packageName: string, packageRoot: string): string | undefined {
  if (!/^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/iu.test(packageName)) return undefined;
  const directory = path.join(path.resolve(packageRoot), 'node_modules', ...packageName.split('/'));
  const manifestPath = path.join(directory, 'package.json');
  if (!existsSync(manifestPath)) return undefined;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    exports?: unknown;
    main?: unknown;
    module?: unknown;
  };
  const entry = rootExport(manifest.exports)
    ?? stringValue(manifest.module)
    ?? stringValue(manifest.main)
    ?? './index.js';
  const resolved = path.resolve(directory, entry);
  return existsSync(resolved) ? resolved : undefined;
}

function rootExport(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record['.'] !== undefined) return rootExport(record['.']);
  for (const condition of ['import', 'node', 'default', 'require']) {
    const resolved = rootExport(record[condition]);
    if (resolved) return resolved;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
