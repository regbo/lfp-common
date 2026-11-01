import { createHash } from 'crypto';
import type { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import semver from 'semver';
import {
  resolveProjectConfig,
  resolveInstalledPackageDirectory,
  validatePackageManifest,
  type CanonicalPynectPackageManifest,
  type PynectModuleManifest,
  type ProjectConfigOverrides,
  type ResolvedProjectConfig,
} from '../config/project';
import { createPynectPyfig } from './pyfig-adapter';
import { withPynectLock } from '../utils/locking';

const PYPROJECT_FILE = 'pyproject.toml';
const UV_LOCK_FILE = 'uv.lock';
const MODULES_FILE = 'modules.json';
const STATE_FILE = '.pynect-state.json';
export interface PynectContribution {
  packageName: string;
  packageVersion: string;
  packageRoot: string;
  manifest: CanonicalPynectPackageManifest;
  root: boolean;
}

export interface ExposedModule extends PynectModuleManifest {
  id: string;
  packageName: string;
}

export interface PynectProjectPlan {
  config: ResolvedProjectConfig;
  contributions: PynectContribution[];
  requirements: Array<{ requirement: string; packageName: string }>;
  overrides: string[];
  modules: Record<string, ExposedModule>;
  pythonRange: string;
  pythonRequirement: string;
  manifestHash: string;
  generatedDirectory: string;
  pyprojectFile: string;
  generatedLockfile: string;
  modulesFile: string;
  stateFile: string;
}

export interface PynectEnvironmentState {
  schemaVersion: 1;
  manifestHash: string;
  lockHash: string;
  pythonVersion: string;
  pythonExecutable: string;
  virtualEnvironment: string;
  pythonAbi: string;
  platform: NodeJS.Platform;
  architecture: string;
  contributors: Array<{ name: string; version: string }>;
  syncedAt: string;
}

export interface SyncProjectOptions extends ProjectConfigOverrides {
  frozen?: boolean;
  offline?: boolean;
}

export interface SyncProjectResult {
  plan: PynectProjectPlan;
  state: PynectEnvironmentState;
  lockfile: string;
}

export function createProjectPlan(
  overrides: ProjectConfigOverrides = {},
): PynectProjectPlan {
  let config = resolveProjectConfig(overrides);
  const contributions = discoverPynectContributions(config.projectRoot);
  const manifestFor = (contribution: PynectContribution) =>
    contribution.root ? config.packageManifest : contribution.manifest;
  const requirements = contributions.flatMap(contribution =>
    (manifestFor(contribution).project.dependencies ?? []).map(requirement => ({
      requirement,
      packageName: contribution.packageName,
    })),
  );
  const modules: Record<string, ExposedModule> = {};
  for (const contribution of contributions) {
    for (const [alias, module] of Object.entries(
      manifestFor(contribution).tool.pynect.modules ?? {},
    )) {
      const id = `${contribution.packageName}:${alias}`;
      if (modules[id]) throw new Error(`Duplicate Pynect module id: ${id}`);
      modules[id] = { ...module, id, packageName: contribution.packageName };
    }
  }
  const requirementOverrides = [
    ...(config.packageManifest.tool.uv['override-dependencies'] ?? []),
  ].sort();

  const pythonConstraints = [
    { range: config.requiresPython, packageName: '<application>' },
    ...contributions
      .filter(contribution =>
        !contribution.root && contribution.manifest.project['requires-python'])
      .map(contribution => ({
        range: contribution.manifest.project['requires-python']!,
        packageName: contribution.packageName,
      })),
  ];
  const { pythonRange, pythonRequirement } = combinePythonRequirements(pythonConstraints);
  if (!config.managedPythonExplicit && !pythonVersionSatisfies(config.managedPython, pythonRange)) {
    config = { ...config, managedPython: managedPythonForRange(pythonRange) };
  }
  const manifestHash = sha256(stableJson({
    schemaVersion: 1,
    project: {
      name: config.packageManifest.project.name,
      version: config.packageManifest.project.version,
    },
    pythonRange,
    pythonRequirement,
    requirements: [...requirements].sort(compareRequirements),
    overrides: requirementOverrides,
    modules,
  }));
  const generatedDirectory = config.generatedDirectory;

  return {
    config,
    contributions,
    requirements,
    overrides: requirementOverrides,
    modules,
    pythonRange,
    pythonRequirement,
    manifestHash,
    generatedDirectory,
    pyprojectFile: path.join(generatedDirectory, PYPROJECT_FILE),
    generatedLockfile: path.join(generatedDirectory, UV_LOCK_FILE),
    modulesFile: path.join(generatedDirectory, MODULES_FILE),
    stateFile: path.join(generatedDirectory, STATE_FILE),
  };
}

export function discoverPynectContributions(projectRoot: string): PynectContribution[] {
  const rootPackage = readPackage(path.join(projectRoot, 'package.json'));
  const queue: Array<{ directory: string; packageJson: PackageJson; root: boolean }> = [
    { directory: projectRoot, packageJson: rootPackage, root: true },
  ];
  const visited = new Set<string>();
  const contributions: PynectContribution[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const realDirectory = fs.realpathSync.native(current.directory);
    if (visited.has(realDirectory)) continue;
    visited.add(realDirectory);

    if (current.root || current.packageJson.pynect !== undefined) {
      const packagePath = path.join(current.directory, 'package.json');
      const manifest = validatePackageManifest(current.packageJson.pynect ?? {}, packagePath);
      if (!current.root) assertTransitiveManifest(manifest, current.packageJson.name, packagePath);
      contributions.push({
        packageName: current.packageJson.name,
        packageVersion: current.packageJson.version,
        packageRoot: current.directory,
        manifest,
        root: current.root,
      });
    }

    const dependencyNames = Object.keys({
      ...current.packageJson.dependencies,
      ...current.packageJson.optionalDependencies,
      ...(current.root ? current.packageJson.devDependencies : {}),
    }).sort();
    for (const dependencyName of dependencyNames) {
      const directory = resolveInstalledPackageDirectory(current.directory, dependencyName);
      if (!directory) continue;
      queue.push({
        directory,
        packageJson: readPackage(path.join(directory, 'package.json')),
        root: false,
      });
    }
  }

  return contributions.sort((left, right) =>
    left.packageName.localeCompare(right.packageName) ||
    left.packageRoot.localeCompare(right.packageRoot),
  );
}

export async function syncProject(options: SyncProjectOptions = {}): Promise<SyncProjectResult> {
  const plan = createProjectPlan(options);
  fs.mkdirSync(plan.generatedDirectory, { recursive: true });
  const locked = await withPynectLock(
    { projectRoot: plan.config.projectRoot },
    async () => syncProjectUnlocked(plan, options),
    undefined,
    {
      key: `pynect-sync:${normalizedPath(plan.config.projectRoot)}`,
      name: 'Pynect project sync',
      namespace: 'pynect',
    },
  );
  if (locked.context.state !== 'executed' || !locked.value) {
    throw new Error(`Loqkit did not execute project synchronization: ${locked.context.state}.`);
  }
  return locked.value;
}

async function syncProjectUnlocked(
  plan: PynectProjectPlan,
  options: SyncProjectOptions,
): Promise<SyncProjectResult> {
  writeGeneratedProject(plan);
  if (options.frozen) stageFrozenLock(plan);

  const client = createPynectPyfig({
    projectRoot: plan.config.projectRoot,
    pythonPath: plan.config.python,
    pythonRange: plan.pythonRange,
    managedPython: plan.config.managedPython,
    uvVersion: plan.config.uvVersion,
    autoInstallPython: plan.config.installPython,
    autoInstallUv: plan.config.installUv,
    autoCreateVirtualEnvironment: plan.config.createVirtualEnvironment,
    env: plan.config.env as Record<string, string>,
  });
  const environment = await client.prepare();

  if (!environment.python.virtualEnvironment) {
    throw new Error('Pyfig did not select a virtual environment for Pynect synchronization.');
  }
  const syncArgs = [
    'sync',
    '--project',
    plan.generatedDirectory,
    '--no-dev',
    '--active',
  ];
  if (options.frozen) syncArgs.push('--locked');
  if (options.offline) syncArgs.push('--offline');
  const synced = await runChild(await client.uv(syncArgs, {
    cwd: plan.config.projectRoot,
    env: {
      ...plan.config.env,
      VIRTUAL_ENV: environment.python.virtualEnvironment,
    },
  }));
  if (synced.code !== 0) {
    throw resolutionError(plan, synced.output);
  }
  if (!options.frozen) atomicWrite(
    plan.config.lockfile,
    fs.readFileSync(plan.generatedLockfile, 'utf8'),
  );

  const lockHash = sha256(fs.readFileSync(plan.config.lockfile));
  const python = environment.python;
  const state: PynectEnvironmentState = {
    schemaVersion: 1,
    manifestHash: plan.manifestHash,
    lockHash,
    pythonVersion: python.version,
    pythonExecutable: python.executable,
    virtualEnvironment: environment.python.virtualEnvironment,
    pythonAbi: `${python.implementation}-${python.version}-${python.architecture}-${python.pointerBits}`,
    platform: process.platform,
    architecture: process.arch,
    contributors: plan.contributions.map(contribution => ({
      name: contribution.packageName,
      version: contribution.packageVersion,
    })),
    syncedAt: new Date().toISOString(),
  };
  atomicWrite(plan.stateFile, `${JSON.stringify(state, null, 2)}\n`);
  return { plan, state, lockfile: plan.config.lockfile };
}

export function validateProjectEnvironment(plan: PynectProjectPlan): PynectEnvironmentState {
  if (!fs.existsSync(plan.config.lockfile)) {
    throw staleEnvironmentError(plan, `lockfile is missing at ${plan.config.lockfile}`);
  }
  if (!fs.existsSync(plan.stateFile)) {
    throw staleEnvironmentError(plan, `environment state is missing at ${plan.stateFile}`);
  }
  let state: PynectEnvironmentState;
  try {
    state = JSON.parse(fs.readFileSync(plan.stateFile, 'utf8')) as PynectEnvironmentState;
  } catch (error) {
    throw staleEnvironmentError(plan, `environment state is invalid: ${(error as Error).message}`);
  }
  const lockHash = sha256(fs.readFileSync(plan.config.lockfile));
  if (state.schemaVersion !== 1 || state.manifestHash !== plan.manifestHash) {
    throw staleEnvironmentError(plan, 'package manifests changed since the last sync');
  }
  if (state.lockHash !== lockHash) {
    throw staleEnvironmentError(plan, 'lockfile changed since the last sync');
  }
  if (state.platform !== process.platform || state.architecture !== process.arch) {
    throw staleEnvironmentError(plan, 'environment was synchronized for another platform');
  }
  if (!state.virtualEnvironment || !fs.existsSync(state.pythonExecutable)) {
    throw staleEnvironmentError(plan, 'recorded Python environment is missing');
  }
  return state;
}

export function requiresProjectSync(plan: PynectProjectPlan): boolean {
  return plan.requirements.length > 0 || plan.contributions.some(contribution => !contribution.root);
}

export function moduleDispatcherIncludes(plan: PynectProjectPlan): string[] {
  return [...new Set(Object.values(plan.modules).flatMap(module => {
    const patterns = module.include?.length ? module.include : ['*'];
    return patterns.map(pattern =>
      pattern === module.import || pattern.startsWith(`${module.import}.`)
        ? pattern
        : `${module.import}.${pattern}`,
    );
  }))].sort();
}

export function resolveExposedModule(
  id: string,
  projectRoot?: string,
): ExposedModule | undefined {
  const plan = createProjectPlan({ projectRoot });
  return plan.modules[id];
}

function writeGeneratedProject(plan: PynectProjectPlan): void {
  atomicWrite(plan.pyprojectFile, renderUvProject(plan));
  atomicWrite(plan.modulesFile, `${JSON.stringify(plan.modules, null, 2)}\n`);
}

export function renderUvProject(plan: PynectProjectPlan): string {
  const requirements = [...new Set(plan.requirements.map(item => item.requirement))].sort();
  const project = plan.config.packageManifest.project;
  const lines = [
    '# Generated by Pynect. Configure package.json#pynect or the Pynect API, not this file.',
    '[project]',
    `name = ${JSON.stringify(project.name ?? 'pynect-environment')}`,
    `version = ${JSON.stringify(project.version ?? '0.0.0')}`,
    `requires-python = ${JSON.stringify(plan.pythonRequirement)}`,
    'dependencies = [',
    ...requirements.map(requirement => `  ${JSON.stringify(requirement)},`),
    ']',
    '',
    '[tool.uv]',
    'package = false',
  ];
  if (plan.overrides.length > 0) {
    lines.push(
      'override-dependencies = [',
      ...plan.overrides.map(requirement => `  ${JSON.stringify(requirement)},`),
      ']',
    );
  }
  return `${lines.join('\n')}\n`;
}

function stageFrozenLock(plan: PynectProjectPlan): void {
  if (!fs.existsSync(plan.config.lockfile)) {
    throw new Error(`Frozen sync requires an existing lockfile at ${plan.config.lockfile}.`);
  }
  atomicWrite(plan.generatedLockfile, fs.readFileSync(plan.config.lockfile, 'utf8'));
}

function resolutionError(plan: PynectProjectPlan, output: string): Error {
  const origins = plan.requirements
    .map(item => `  ${item.packageName} requires ${item.requirement}`)
    .join('\n');
  return new Error(
    `Unable to resolve Python requirements:${origins ? `\n\n${origins}` : ''}` +
    `\n\nuv reported:\n${output.trim()}`,
  );
}

function staleEnvironmentError(plan: PynectProjectPlan, detail: string): Error {
  return new Error(
    `Pynect environment is not synchronized: ${detail}. Run "pynect sync" ` +
    `from ${plan.config.projectRoot}.`,
  );
}

function assertTransitiveManifest(
  manifest: CanonicalPynectPackageManifest,
  packageName: string,
  source: string,
): void {
  const policyKeys = [
    ...Object.keys(manifest.tool.pynect)
      .filter(key => key !== 'modules' &&
        manifest.tool.pynect[key as keyof typeof manifest.tool.pynect] !== undefined)
      .map(key => `tool.pynect.${key}`),
    ...Object.keys(manifest.tool.uv)
      .filter(key => key !== 'package' && manifest.tool.uv[key as keyof typeof manifest.tool.uv] !== undefined)
      .map(key => `tool.uv.${key}`),
  ];
  if (policyKeys.length > 0) {
    throw new TypeError(
      `${source}: transitive package ${packageName} cannot set application policy: ` +
      policyKeys.join(', '),
    );
  }
}

interface PythonConstraint {
  range: string;
  packageName: string;
}

function combinePythonRequirements(constraints: PythonConstraint[]): {
  pythonRange: string;
  pythonRequirement: string;
} {
  const pythonRequirement = constraints
    .map(constraint => constraint.range.trim().replace(/\s+(?=[<>=!~])/g, ','))
    .filter(Boolean)
    .join(',');
  const candidate = pythonRequirement.replace(/,/g, ' ');
  const pythonRange = semver.validRange(candidate);
  if (!pythonRange || !semver.minVersion(pythonRange)) {
    throw new Error(
      'Unable to resolve Python version requirements:\n\n' +
      constraints.map(item => `  ${item.packageName} requires Python ${item.range}`).join('\n'),
    );
  }
  return { pythonRange, pythonRequirement };
}

function pythonVersionSatisfies(version: string, range: string): boolean {
  const normalized = semver.coerce(version)?.version;
  return normalized !== undefined && semver.satisfies(normalized, range);
}

function managedPythonForRange(range: string): string {
  const minimum = semver.minVersion(range);
  if (!minimum) throw new TypeError(`Python range has no installable version: ${range}`);
  return `${minimum.major}.${minimum.minor}`;
}

interface PackageJson {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  pynect?: unknown;
}

function readPackage(packagePath: string): PackageJson {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Unable to read ${packagePath}: ${(error as Error).message}`);
  }
  if (!isRecord(value)) throw new TypeError(`${packagePath} must contain an object.`);
  return {
    ...value,
    name: typeof value['name'] === 'string' ? value['name'] : path.basename(path.dirname(packagePath)),
    version: typeof value['version'] === 'string' ? value['version'] : '0.0.0',
  } as PackageJson;
}

async function runChild(child: ChildProcess): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    let output = '';
    child.stdout?.on('data', chunk => { output += String(chunk); });
    child.stderr?.on('data', chunk => { output += String(chunk); });
    child.on('error', reject);
    child.on('close', code => resolve({ code: code ?? 1, output }));
  });
}

function atomicWrite(destination: string, contents: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, contents, 'utf8');
  fs.renameSync(temporary, destination);
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function compareRequirements(
  left: { requirement: string; packageName: string },
  right: { requirement: string; packageName: string },
): number {
  return left.requirement.localeCompare(right.requirement) ||
    left.packageName.localeCompare(right.packageName);
}

function pathsEqual(left: string, right: string): boolean {
  return normalizedPath(left) === normalizedPath(right);
}

function normalizedPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
