import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCommand } from './process.ts';

const allowedRootFiles = new Set(['LICENSE', 'README.md', 'package.json']);
const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu;
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bgh[opusr]_[A-Za-z0-9_]{20,}\b/u,
  /\bnpm_[A-Za-z0-9]{20,}\b/u,
] as const;

export interface ArchiveAudit {
  readonly files: readonly string[];
  readonly name: string;
  readonly version: string;
}

/** Audit the exact npm archive that will be published. */
export async function auditArchive(
  archivePath: string,
  expectedName: string,
  expectedVersion: string,
): Promise<ArchiveAudit> {
  const extractionRoot = await mkdtemp(join(tmpdir(), 'optionkit-audit-'));
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
    for (const required of ['LICENSE', 'README.md', 'dist/index.d.ts', 'dist/index.js']) {
      if (!files.includes(required)) throw new Error(`Archive is missing required file: ${required}`);
    }
    for (const file of files) {
      if (!allowedRootFiles.has(file) && !file.startsWith('dist/')) {
        throw new Error(`Archive contains unintended file: ${file}`);
      }
      const content = new TextDecoder().decode(await Bun.file(join(packageRoot, file)).arrayBuffer());
      if (content.includes('\0')) continue;
      if (emailPattern.test(content)) throw new Error(`Archive contains an email address in ${file}`);
      if (secretPatterns.some(pattern => pattern.test(content))) {
        throw new Error(`Archive contains secret-shaped content in ${file}`);
      }
    }
    return Object.freeze({ files, name: expectedName, version: expectedVersion });
  } finally {
    await rm(extractionRoot, { force: true, recursive: true });
  }
}
