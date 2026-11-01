import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCommand } from './process.ts';

const allowedRootFiles = new Set([
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'binding.gyp',
  'package.json',
]);
const allowedPrefixes = ['dist/', 'prebuilds/', 'python/', 'scripts/', 'src/native/'] as const;
const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[opusr]_[A-Za-z0-9_]{20,}\b/,
  /\bnpm_[A-Za-z0-9]{20,}\b/,
] as const;

export interface ArchiveAudit {
  readonly files: readonly string[];
  readonly name: string;
  readonly version: string;
}

/** Audits the exact npm archive that will be published. */
export async function auditArchive(
  archivePath: string,
  expectedName: string,
  expectedVersion: string,
): Promise<ArchiveAudit> {
  const extractionRoot = await mkdtemp(join(tmpdir(), 'pynect-audit-'));
  try {
    await runCommand('tar', ['-xzf', resolve(archivePath), '-C', extractionRoot]);
    const packageRoot = join(extractionRoot, 'package');
    const manifest = JSON.parse(
      await readFile(join(packageRoot, 'package.json'), 'utf8'),
    ) as { name?: string; version?: string };
    if (manifest.name !== expectedName || manifest.version !== expectedVersion) {
      throw new Error(
        `Archive manifest is ${manifest.name}@${manifest.version}; expected ${expectedName}@${expectedVersion}`,
      );
    }

    const files = Array.from(
      new Bun.Glob('**/*').scanSync({ cwd: packageRoot, onlyFiles: true }),
      file => file.replaceAll('\\', '/'),
    ).sort();
    for (const required of [
      'LICENSE',
      'README.md',
      'SECURITY.md',
      'binding.gyp',
      'dist/index.d.ts',
      'dist/index.js',
      'python/pynect_runtime.py',
      'scripts/cli.js',
      'scripts/postinstall.js',
      'src/native/pynect_addon.cpp',
    ]) {
      if (!files.includes(required)) {
        throw new Error(`Archive is missing required file: ${required}`);
      }
    }
    for (const file of files) {
      if (!allowedRootFiles.has(file) && !allowedPrefixes.some(prefix => file.startsWith(prefix))) {
        throw new Error(`Archive contains unintended file: ${file}`);
      }
      const bytes = await Bun.file(join(packageRoot, file)).arrayBuffer();
      const content = new TextDecoder().decode(bytes);
      if (content.includes('\0')) continue;
      if (emailPattern.test(content)) {
        throw new Error(`Archive contains an email address in ${file}`);
      }
      if (secretPatterns.some(pattern => pattern.test(content))) {
        throw new Error(`Archive contains secret-shaped content in ${file}`);
      }
    }

    return Object.freeze({ files, name: expectedName, version: expectedVersion });
  } finally {
    await rm(extractionRoot, { force: true, recursive: true });
  }
}
