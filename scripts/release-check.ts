import { githubRepositoryFromRemote, registryVersionUrl } from './release-lib.ts';
import {
  ROOT,
  WORKSPACES,
  readManifest,
  sharedVersion,
  workspacePath,
} from './workspaces.ts';

const version = await sharedVersion();
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (tag !== `v${version}`) {
  throw new Error(`Release tag ${tag ?? '<missing>'} must exactly match v${version}.`);
}

const rootManifest = await readManifest(ROOT);
const rootRepository = typeof rootManifest.repository === 'string'
  ? rootManifest.repository
  : rootManifest.repository?.url;
if (!rootRepository || !githubRepositoryFromRemote(rootRepository)) {
  throw new Error('Root package repository must identify a GitHub repository.');
}

for (const workspace of WORKSPACES) {
  const manifest = await readManifest(workspacePath(workspace));
  const response = await fetch(registryVersionUrl(manifest.name, version), { redirect: 'error' });
  if (response.ok) throw new Error(`${manifest.name}@${version} is already published.`);
  if (response.status !== 404) {
    throw new Error(`Could not verify ${manifest.name}@${version}: HTTP ${response.status}.`);
  }
}

console.log(`Release validated: ${tag} for ${WORKSPACES.length} packages.`);
