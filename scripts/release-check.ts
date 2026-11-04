import { githubRepositoryFromRemote, registryVersionUrl } from './release-lib.ts';
import {
  ROOT,
  PYTHON_DISTRIBUTIONS,
  WORKSPACES,
  readManifest,
  pypiVersionUrl,
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

for (const project of PYTHON_DISTRIBUTIONS) {
  const response = await fetch(pypiVersionUrl(project.name, version), { redirect: 'error' });
  if (response.ok) throw new Error(`${project.name}==${version} is already published on PyPI.`);
  if (response.status !== 404) {
    throw new Error(`Could not verify ${project.name}==${version} on PyPI: HTTP ${response.status}.`);
  }
}

console.log(
  `Release validated: ${tag} for ${WORKSPACES.length} npm and ` +
  `${PYTHON_DISTRIBUTIONS.length} PyPI package(s).`,
);
