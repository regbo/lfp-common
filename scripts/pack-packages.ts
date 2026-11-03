import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { auditArchive, type ArchiveAudit } from './archive.ts';
import { runBun } from './process.ts';
import {
  ROOT,
  WORKSPACES,
  sharedVersion,
  workspacePath,
} from './workspaces.ts';

export async function packPackages(destination: string): Promise<readonly ArchiveAudit[]> {
  const output = path.resolve(destination);
  await mkdir(output, { recursive: true });
  const version = await sharedVersion();
  const audits: ArchiveAudit[] = [];

  for (const workspace of WORKSPACES) {
    const filename = await runBun([
      'pm',
      'pack',
      '--ignore-scripts',
      '--destination',
      output,
      '--quiet',
    ], { cwd: workspacePath(workspace) });
    const archive = path.resolve(output, filename);
    const audit = await auditArchive(archive, workspace, version);
    audits.push(audit);
    console.log(`Audited ${audit.name}@${audit.version} (${audit.files.length} files).`);
  }
  return audits;
}
if (import.meta.main) {
  const destination = path.resolve(process.argv[2] ?? path.join(ROOT, 'dist', 'packages'));
  const managedDestination = path.join(ROOT, 'dist', 'packages');
  if (destination === managedDestination) {
    await rm(destination, { recursive: true, force: true });
  }
  await packPackages(destination);
}
