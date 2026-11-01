import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

declare const PYFIG_CJS_DIRECTORY: string | undefined;

/** Resolve a compiled runtime helper beside either the ESM files or the CJS bundle. */
export function runtimeFile(name: string): string {
  const moduleDirectory = typeof PYFIG_CJS_DIRECTORY === 'string'
    ? PYFIG_CJS_DIRECTORY
    : path.dirname(fileURLToPath(import.meta.url));
  const compiled = path.join(moduleDirectory, `${name}.js`);
  return fs.existsSync(compiled) ? compiled : path.join(moduleDirectory, `${name}.ts`);
}
