import path from 'node:path';
import { auditArchive } from './archive.ts';
import { runCommand } from './process.ts';
import {
  archiveName,
  sharedVersion,
  workspaceDependencyOrder,
} from './workspaces.ts';

const directory = path.resolve(process.argv[2] ?? 'dist/packages');
const version = await sharedVersion();
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

for (const workspace of await workspaceDependencyOrder()) {
  const archive = path.join(directory, archiveName(workspace.name, version));
  await auditArchive(archive, workspace, version);
  await runCommand(npm, [
    'publish',
    archive,
    '--access',
    'public',
    '--tag',
    'latest',
    '--provenance',
  ], { inherit: true });
}
