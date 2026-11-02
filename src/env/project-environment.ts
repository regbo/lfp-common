import fs from 'fs';
import path from 'path';
import semver from 'semver';
import type { PythonEnvironment } from 'pyfig';
import {
  resolveProjectConfig,
  resolveInstalledPackageDirectory,
  validatePackageManifest,
  PYNECT_REQUIRES_PYTHON,
  type CanonicalPynectPackageManifest,
  type PynectModuleManifest,
  type ProjectConfigOverrides,
  type ResolvedProjectConfig,
} from '../config/project';
import { createPython, type PynectPythonOptions } from './python';

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
  dependencies: Array<{ dependency: string; packageName: string }>;
  requirements: string[];
  modules: Record<string, ExposedModule>;
  pythonRange: string;
  pythonRequirement: string;
}

export interface SyncProjectOptions extends ProjectConfigOverrides {
  offline?: boolean;
}

export interface SyncProjectResult {
  plan: PynectProjectPlan;
  environment: PythonEnvironment;
}

export function createProjectPlan(
  overrides: ProjectConfigOverrides = {},
): PynectProjectPlan {
  let config = resolveProjectConfig(overrides);
  const contributions = discoverPynectContributions(config.projectRoot);
  const manifestFor = (contribution: PynectContribution) =>
    contribution.root ? config.packageManifest : contribution.manifest;
  const dependencies = contributions.flatMap(contribution =>
    (manifestFor(contribution).project.dependencies ?? []).map(dependency => ({
      dependency,
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

  const pythonConstraints = [
    { range: PYNECT_REQUIRES_PYTHON, packageName: 'pynect' },
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

  return {
    config,
    contributions,
    dependencies,
    requirements: config.requirements,
    modules,
    pythonRange,
    pythonRequirement,
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

export function projectPythonOptions(
  plan: PynectProjectPlan,
  options: { offline?: boolean } = {},
): PynectPythonOptions {
  return {
    projectRoot: plan.config.projectRoot,
    python: plan.config.python || undefined,
    requiresPython: plan.pythonRequirement,
    managedPython: plan.config.managedPython,
    requiresUv: plan.config.requiresUv,
    installPython: plan.config.installPython,
    installUv: plan.config.installUv,
    createVirtualEnvironment: plan.config.createVirtualEnvironment,
    dependencies: [...new Set(plan.dependencies.map(item => item.dependency))].sort(),
    requirements: plan.requirements,
    env: {
      ...plan.config.env,
      ...(options.offline ? { UV_OFFLINE: '1' } : {}),
    },
  };
}

export async function syncProject(options: SyncProjectOptions = {}): Promise<SyncProjectResult> {
  const plan = createProjectPlan(options);
  const runtime = createPython(projectPythonOptions(plan, options));
  try {
    return { plan, environment: await runtime.prepare() };
  } catch (error) {
    const origins = plan.dependencies
      .map(item => `  ${item.packageName} requires ${item.dependency}`)
      .join('\n');
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to prepare the Python environment:${origins ? `\n\n${origins}` : ''}` +
      `\n\nPyfig reported:\n${detail}`,
      { cause: error },
    );
  }
}

export function requiresProjectSync(plan: PynectProjectPlan): boolean {
  return plan.dependencies.length > 0 || plan.requirements.length > 0;
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

function assertTransitiveManifest(
  manifest: CanonicalPynectPackageManifest,
  packageName: string,
  source: string,
): void {
  const policyKeys = Object.keys(manifest.tool.pynect)
    .filter(key => key !== 'modules' &&
      manifest.tool.pynect[key as keyof typeof manifest.tool.pynect] !== undefined)
    .map(key => `tool.pynect.${key}`);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
