import path from 'node:path';
import * as tar from 'tar';
import type { WorkspaceDefinition } from './workspaces.ts';

const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu;
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bgh[opusr]_[A-Za-z0-9_]{20,}\b/u,
  /\bnpm_[A-Za-z0-9]{20,}\b/u,
] as const;

export interface ArchiveAudit {
  readonly archive: string;
  readonly files: readonly string[];
  readonly name: string;
  readonly version: string;
}
/** Audit the exact tarball passed to npm publish. */
export async function auditArchive(
  archive: string,
  workspace: WorkspaceDefinition,
  expectedVersion: string,
): Promise<ArchiveAudit> {
  const entries: Array<Promise<{ readonly name: string; readonly content: Buffer }>> = [];
  await tar.t({
    file: archive,
    onentry(entry) {
      if (entry.type !== 'File') {
        entry.resume();
        return;
      }
      entries.push(new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        entry.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        entry.once('error', reject);
        entry.once('end', () => resolve({
          name: entry.path.replaceAll('\\', '/'),
          content: Buffer.concat(chunks),
        }));
      }));
    },
  });

  const files = await Promise.all(entries);
  const names = files.map(file => file.name).sort();
  for (const required of ['package/package.json', ...workspace.requiredFiles]) {
    if (!names.includes(required)) throw new Error(`${workspace.name} archive is missing ${required}.`);
  }

  const manifestEntry = files.find(file => file.name === 'package/package.json');
  if (!manifestEntry) throw new Error(`${workspace.name} archive has no package.json.`);
  const manifest = JSON.parse(manifestEntry.content.toString('utf8')) as {
    name?: string;
    version?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  if (manifest.name !== workspace.name || manifest.version !== expectedVersion) {
    throw new Error(
      `${workspace.name} archive is ${manifest.name}@${manifest.version}; expected ${workspace.name}@${expectedVersion}.`,
    );
  }
  for (const section of [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ]) {
    for (const [name, specifier] of Object.entries(section ?? {})) {
      if (/^(?:catalog|workspace):/u.test(specifier)) {
        throw new Error(`${workspace.name} archive left ${name} unresolved as ${specifier}.`);
      }
    }
  }

  for (const file of files) {
    if (file.content.includes(0)) continue;
    const content = file.content.toString('utf8');
    if (emailPattern.test(content)) {
      throw new Error(`${workspace.name} archive contains email-shaped metadata in ${file.name}.`);
    }
    if (secretPatterns.some(pattern => pattern.test(content))) {
      throw new Error(`${workspace.name} archive contains secret-shaped content in ${file.name}.`);
    }
  }

  return {
    archive: path.resolve(archive),
    files: names,
    name: workspace.name,
    version: expectedVersion,
  };
}
