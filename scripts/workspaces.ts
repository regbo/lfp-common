import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dir, '..');

export interface WorkspaceDefinition {
  readonly name: 'loqkit' | 'optionkit' | 'pyfig' | 'pynect';
  readonly directory: string;
  readonly requiredFiles: readonly string[];
}
export const WORKSPACES: readonly WorkspaceDefinition[] = [
  {
    name: 'loqkit',
    directory: 'packages/loqkit',
    requiredFiles: [
      'package/LICENSE',
      'package/README.md',
      'package/release/cjs/index.js',
      'package/release/index.d.ts',
      'package/release/index.js',
      'package/src/index.ts',
    ],
  },
  {
    name: 'optionkit',
    directory: 'packages/optionkit',
    requiredFiles: [
      'package/LICENSE',
      'package/README.md',
      'package/dist/index.d.ts',
      'package/dist/index.js',
    ],
  },
  {
    name: 'pyfig',
    directory: 'packages/pyfig',
    requiredFiles: [
      'package/LICENSE',
      'package/README.md',
      'package/dist/cli.js',
      'package/dist/index.d.ts',
      'package/dist/index.js',
    ],
  },
  {
    name: 'pynect',
    directory: 'packages/pynect',
    requiredFiles: [
      'package/LICENSE',
      'package/README.md',
      'package/dist/js/cli.mjs',
      'package/dist/js/index.d.ts',
      'package/dist/js/index.js',
      'package/dist/py/pynect_worker.py',
    ],
  },
] as const;

export interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly repository?: string | { readonly directory?: string; readonly url?: string };
}

export function workspacePath(workspace: WorkspaceDefinition): string {
  return path.join(ROOT, workspace.directory);
}

export async function readManifest(directory: string): Promise<PackageManifest> {
  return JSON.parse(
    await readFile(path.join(directory, 'package.json'), 'utf8'),
  ) as PackageManifest;
}

export async function readWorkspaceManifests(): Promise<ReadonlyMap<string, PackageManifest>> {
  const entries = await Promise.all(WORKSPACES.map(async workspace => {
    const manifest = await readManifest(workspacePath(workspace));
    if (manifest.name !== workspace.name) {
      throw new Error(`${workspace.directory} is ${manifest.name}, expected ${workspace.name}.`);
    }
    return [workspace.name, manifest] as const;
  }));
  return new Map(entries);
}

/** Derive dependency order from workspace protocol declarations. */
export async function workspaceDependencyOrder(): Promise<readonly WorkspaceDefinition[]> {
  const manifests = await readWorkspaceManifests();
  const definitions = new Map<string, WorkspaceDefinition>(
    WORKSPACES.map(workspace => [workspace.name, workspace]),
  );
  const ordered: WorkspaceDefinition[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (name: string): void => {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error(`Workspace dependency cycle includes ${name}.`);
    const manifest = manifests.get(name);
    const definition = definitions.get(name);
    if (!manifest || !definition) throw new Error(`Unknown workspace: ${name}.`);

    visiting.add(name);
    for (const [dependency, specifier] of Object.entries(manifest.dependencies ?? {})) {
      if (specifier.startsWith('workspace:') && definitions.has(dependency)) visit(dependency);
    }
    visiting.delete(name);
    visited.add(name);
    ordered.push(definition);
  };

  for (const workspace of WORKSPACES) visit(workspace.name);
  return ordered;
}

export async function sharedVersion(): Promise<string> {
  const root = await readManifest(ROOT);
  const manifests = await readWorkspaceManifests();
  const mismatches = [...manifests].filter(([, manifest]) => manifest.version !== root.version);
  if (mismatches.length > 0) {
    throw new Error(
      `Workspace versions must equal root ${root.version}: ` +
      mismatches.map(([name, manifest]) => `${name}@${manifest.version}`).join(', '),
    );
  }
  return root.version;
}

export function archiveName(name: string, version: string): string {
  return `${name.replace(/^@/u, '').replace('/', '-')}-${version}.tgz`;
}
