import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import {
  DEFAULT_MANAGED_PYTHON,
  DEFAULT_REQUIRES_PYTHON,
  DEFAULT_REQUIRES_UV,
  resolveProjectRoot,
} from 'pyfig';

export type AutoSyncMode = 'never' | 'if-missing';
export const CURRENT_PYNECT_SCHEMA_VERSION = 1 as const;

export interface PynectModuleManifest {
  import: string;
  include?: string[];
}

export interface PynectProjectTable {
  name?: string;
  version?: string;
  'requires-python'?: string;
  dependencies?: string[];
}

export interface PynectUvTable {
  package?: false;
  'override-dependencies'?: string[];
}

export interface PynectToolTable {
  modules?: Record<string, PynectModuleManifest>;
  python?: string;
  managedPython?: string;
  uvVersion?: string;
  installPython?: boolean;
  installUv?: boolean;
  createVirtualEnvironment?: boolean;
  autoSync?: AutoSyncMode;
  lockfile?: string;
  generatedDirectory?: string;
}

export interface CanonicalPynectPackageManifest {
  schemaVersion: typeof CURRENT_PYNECT_SCHEMA_VERSION;
  project: PynectProjectTable;
  tool: {
    uv: PynectUvTable;
    pynect: PynectToolTable;
  };
}

export interface PynectPackageManifest {
  /** Omit to use the latest schema understood by this Pynect version. */
  schemaVersion?: typeof CURRENT_PYNECT_SCHEMA_VERSION;
  project?: PynectProjectTable;
  tool?: {
    uv?: PynectUvTable;
    pynect?: PynectToolTable;
  };
  /** @deprecated Use project["requires-python"]. */
  requiresPython?: string;
  /** @deprecated Use project.dependencies. */
  requirements?: string[];
  /** @deprecated Use tool.uv["override-dependencies"]. */
  overrides?: Record<string, string>;
  /** @deprecated Use tool.pynect.modules. */
  modules?: Record<string, PynectModuleManifest>;
  /** @deprecated Use tool.pynect.python. */
  python?: string;
  /** @deprecated Use tool.pynect.managedPython. */
  managedPython?: string;
  /** @deprecated Use tool.pynect.uvVersion. */
  uvVersion?: string;
  /** @deprecated Use tool.pynect.installPython. */
  installPython?: boolean;
  /** @deprecated Use tool.pynect.installUv. */
  installUv?: boolean;
  /** @deprecated Use tool.pynect.createVirtualEnvironment. */
  createVirtualEnvironment?: boolean;
  /** @deprecated Use tool.pynect.autoSync. */
  autoSync?: AutoSyncMode;
  /** @deprecated Use tool.pynect.lockfile. */
  lockfile?: string;
  /** @deprecated Use tool.pynect.generatedDirectory. */
  generatedDirectory?: string;
}

export interface ProjectConfigOverrides extends PynectPackageManifest {
  /** @deprecated Pass project and tool directly. */
  pynect?: PynectPackageManifest;
  projectRoot?: string;
  python?: string;
  requiresPython?: string;
  managedPython?: string;
  uvVersion?: string;
  installPython?: boolean;
  installUv?: boolean;
  createVirtualEnvironment?: boolean;
  autoSync?: AutoSyncMode;
  lockfile?: string;
  generatedDirectory?: string;
  env?: Record<string, string | undefined>;
}

export interface ResolvedProjectConfig {
  projectRoot: string;
  python: string;
  requiresPython: string;
  managedPython: string;
  managedPythonExplicit: boolean;
  uvVersion: string;
  installPython: boolean;
  installUv: boolean;
  createVirtualEnvironment: boolean;
  autoSync: AutoSyncMode;
  lockfile: string;
  generatedDirectory: string;
  packageManifest: CanonicalPynectPackageManifest;
  env: NodeJS.ProcessEnv;
}

const DEFAULTS = {
  python: '',
  requiresPython: DEFAULT_REQUIRES_PYTHON,
  managedPython: DEFAULT_MANAGED_PYTHON,
  uvVersion: DEFAULT_REQUIRES_UV,
  installPython: true,
  installUv: true,
  createVirtualEnvironment: true,
  autoSync: 'never' as AutoSyncMode,
  lockfile: 'pynect.lock',
};

/**
 * Resolve one project policy for the runtime and CLI.
 * Precedence is API or CLI overrides, environment, root package.json, then defaults.
 */
export function resolveProjectConfig(
  overrides: ProjectConfigOverrides = {},
): ResolvedProjectConfig {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides.env };
  const rootHint = overrides.projectRoot ?? env['PYNECT_PROJECT_ROOT'] ?? env['INIT_CWD'];
  const projectRoot = path.resolve(rootHint || resolveProjectRoot(process.cwd()));
  const packageManifest = readRootPynectManifest(projectRoot);
  const apiManifest = validatePackageManifest(
    overrides.pynect ?? overrides,
    'Pynect API config',
  );
  const manifest = mergeCanonicalManifests(packageManifest, apiManifest);
  const project = manifest.project;
  const apiProject = apiManifest.project;
  const apiTool = apiManifest.tool.pynect;
  const packageTool = packageManifest.tool.pynect;

  const python = first(
    overrides.python,
    apiTool.python,
    env['PYNECT_PYTHON'],
    packageTool.python,
    DEFAULTS.python,
  );
  const requiresPython = first(
    overrides.requiresPython,
    apiProject['requires-python'],
    env['PYNECT_REQUIRES_PYTHON'],
    packageManifest.project['requires-python'],
    DEFAULTS.requiresPython,
  );
  const configuredManagedPython = first(
    overrides.managedPython,
    apiTool.managedPython,
    env['PYNECT_MANAGED_PYTHON'],
    env['PYNECT_PYTHON_VERSION'],
    packageTool.managedPython,
  );
  const managedPython = configuredManagedPython ?? DEFAULTS.managedPython;
  const uvVersion = first(
    overrides.uvVersion,
    apiTool.uvVersion,
    env['PYNECT_REQUIRES_UV'],
    env['PYNECT_UV_VERSION'],
    packageTool.uvVersion,
    DEFAULTS.uvVersion,
  );
  const autoSync = parseAutoSync(first(
    overrides.autoSync,
    apiTool.autoSync,
    env['PYNECT_AUTO_SYNC'],
    packageTool.autoSync,
    DEFAULTS.autoSync,
  ));
  const lockfile = first(
    overrides.lockfile,
    apiTool.lockfile,
    env['PYNECT_LOCKFILE'],
    packageTool.lockfile,
    DEFAULTS.lockfile,
  );
  const generatedDirectory = path.resolve(projectRoot, first(
    overrides.generatedDirectory,
    apiTool.generatedDirectory,
    env['PYNECT_GENERATED_DIRECTORY'],
    packageTool.generatedDirectory,
    defaultGeneratedDirectory(projectRoot),
  ));
  const installPython = resolveBoolean(
    first(overrides.installPython, apiTool.installPython),
    env['PYNECT_INSTALL_PYTHON'] ?? env['PYNECT_AUTO_INSTALL'],
    packageTool.installPython,
    DEFAULTS.installPython,
    'PYNECT_INSTALL_PYTHON',
  );
  const installUv = resolveBoolean(
    first(overrides.installUv, apiTool.installUv),
    env['PYNECT_INSTALL_UV'],
    packageTool.installUv,
    DEFAULTS.installUv,
    'PYNECT_INSTALL_UV',
  );
  const createVirtualEnvironment = resolveBoolean(
    first(overrides.createVirtualEnvironment, apiTool.createVirtualEnvironment),
    env['PYNECT_CREATE_VIRTUAL_ENVIRONMENT'],
    packageTool.createVirtualEnvironment,
    DEFAULTS.createVirtualEnvironment,
    'PYNECT_CREATE_VIRTUAL_ENVIRONMENT',
  );
  const resolvedManifest: CanonicalPynectPackageManifest = {
    schemaVersion: CURRENT_PYNECT_SCHEMA_VERSION,
    project: {
      name: project.name ?? 'pynect-environment',
      version: project.version ?? '0.0.0',
      'requires-python': requiresPython,
      dependencies: project.dependencies ?? [],
    },
    tool: {
      uv: {
        package: false,
        'override-dependencies': manifest.tool.uv['override-dependencies'] ?? [],
      },
      pynect: {
        modules: manifest.tool.pynect.modules ?? {},
        python,
        managedPython,
        uvVersion,
        installPython,
        installUv,
        createVirtualEnvironment,
        autoSync,
        lockfile,
        generatedDirectory,
      },
    },
  };

  return {
    projectRoot,
    python,
    requiresPython,
    managedPython,
    managedPythonExplicit: configuredManagedPython !== undefined,
    uvVersion,
    installPython,
    installUv,
    createVirtualEnvironment,
    autoSync,
    lockfile: resolveInsideProject(projectRoot, lockfile, 'pynect.lock'),
    generatedDirectory,
    packageManifest: resolvedManifest,
    env,
  };
}

export function readRootPynectManifest(projectRoot: string): CanonicalPynectPackageManifest {
  const packagePath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(packagePath)) return emptyCanonicalManifest();
  let contents: unknown;
  try {
    contents = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Unable to read ${packagePath}: ${(error as Error).message}`);
  }
  const value = (contents as { pynect?: unknown }).pynect;
  if (value === undefined) return emptyCanonicalManifest();
  return validatePackageManifest(value, packagePath);
}

export function validatePackageManifest(
  value: unknown,
  source: string,
): CanonicalPynectPackageManifest {
  if (!isRecord(value)) throw new TypeError(`${source}: pynect must be an object.`);
  if (value['schemaVersion'] !== undefined &&
    value['schemaVersion'] !== CURRENT_PYNECT_SCHEMA_VERSION) {
    throw new TypeError(
      `${source}: pynect.schemaVersion must be ${CURRENT_PYNECT_SCHEMA_VERSION} when specified.`,
    );
  }

  const project = optionalRecord(value, 'project', source);
  optionalString(project, 'name', `${source}: pynect.project`);
  optionalString(project, 'version', `${source}: pynect.project`);
  optionalString(project, 'requires-python', `${source}: pynect.project`);
  if (project['dependencies'] !== undefined) {
    validateRequirements(project['dependencies'], `${source}: pynect.project.dependencies`);
  }

  const toolTables = optionalRecord(value, 'tool', source);
  const uv = optionalRecord(toolTables, 'uv', `${source}: pynect.tool`);
  if (uv['package'] !== undefined && uv['package'] !== false) {
    throw new TypeError(`${source}: pynect.tool.uv.package must be false.`);
  }
  if (uv['override-dependencies'] !== undefined) {
    validateRequirements(
      uv['override-dependencies'],
      `${source}: pynect.tool.uv["override-dependencies"]`,
    );
  }

  const pynectTool = optionalRecord(toolTables, 'pynect', `${source}: pynect.tool`);
  validatePynectTool(pynectTool, source);

  // Flat keys remain accepted so existing packages can migrate without a flag day.
  optionalString(value, 'requiresPython', source);
  optionalString(value, 'python', source);
  optionalString(value, 'managedPython', source);
  optionalString(value, 'uvVersion', source);
  optionalString(value, 'lockfile', source);
  optionalString(value, 'generatedDirectory', source);
  optionalBoolean(value, 'installPython', source);
  optionalBoolean(value, 'installUv', source);
  optionalBoolean(value, 'createVirtualEnvironment', source);
  if (value['autoSync'] !== undefined) parseAutoSync(value['autoSync']);
  if (value['requirements'] !== undefined) {
    validateRequirements(value['requirements'], `${source}: pynect.requirements`);
  }
  if (value['modules'] !== undefined) validateModules(value['modules'], source);
  if (value['overrides'] !== undefined) validateOverrides(value['overrides'], source);

  const legacyOverrides = value['overrides'] === undefined
    ? undefined
    : Object.entries(value['overrides'] as Record<string, string>)
      .map(([distribution, constraint]) => `${distribution}${constraint}`)
      .sort();
  return {
    schemaVersion: CURRENT_PYNECT_SCHEMA_VERSION,
    project: {
      name: project['name'] as string | undefined,
      version: project['version'] as string | undefined,
      'requires-python': first(
        project['requires-python'] as string | undefined,
        value['requiresPython'] as string | undefined,
      ),
      dependencies: first(
        project['dependencies'] as string[] | undefined,
        value['requirements'] as string[] | undefined,
      ),
    },
    tool: {
      uv: {
        package: false,
        'override-dependencies': first(
          uv['override-dependencies'] as string[] | undefined,
          legacyOverrides,
        ),
      },
      pynect: {
        modules: first(
          pynectTool['modules'] as Record<string, PynectModuleManifest> | undefined,
          value['modules'] as Record<string, PynectModuleManifest> | undefined,
        ),
        python: first(
          pynectTool['python'] as string | undefined,
          value['python'] as string | undefined,
        ),
        managedPython: first(
          pynectTool['managedPython'] as string | undefined,
          value['managedPython'] as string | undefined,
        ),
        uvVersion: first(
          pynectTool['uvVersion'] as string | undefined,
          value['uvVersion'] as string | undefined,
        ),
        installPython: first(
          pynectTool['installPython'] as boolean | undefined,
          value['installPython'] as boolean | undefined,
        ),
        installUv: first(
          pynectTool['installUv'] as boolean | undefined,
          value['installUv'] as boolean | undefined,
        ),
        createVirtualEnvironment: first(
          pynectTool['createVirtualEnvironment'] as boolean | undefined,
          value['createVirtualEnvironment'] as boolean | undefined,
        ),
        autoSync: first(
          pynectTool['autoSync'] as AutoSyncMode | undefined,
          value['autoSync'] as AutoSyncMode | undefined,
        ),
        lockfile: first(
          pynectTool['lockfile'] as string | undefined,
          value['lockfile'] as string | undefined,
        ),
        generatedDirectory: first(
          pynectTool['generatedDirectory'] as string | undefined,
          value['generatedDirectory'] as string | undefined,
        ),
      },
    },
  };
}

function validateOverrides(value: unknown, source: string): void {
  if (!isRecord(value)) throw new TypeError(`${source}: pynect.overrides must be an object.`);
  for (const [distribution, constraint] of Object.entries(value)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(distribution) ||
      typeof constraint !== 'string' || !constraint.trim() || /[\0\r\n]/u.test(constraint)) {
      throw new TypeError(`${source}: invalid Pynect override for ${JSON.stringify(distribution)}.`);
    }
  }
}

function validatePynectTool(value: Record<string, unknown>, source: string): void {
  optionalString(value, 'python', `${source}: pynect.tool.pynect`);
  optionalString(value, 'managedPython', `${source}: pynect.tool.pynect`);
  optionalString(value, 'uvVersion', `${source}: pynect.tool.pynect`);
  optionalString(value, 'lockfile', `${source}: pynect.tool.pynect`);
  optionalString(value, 'generatedDirectory', `${source}: pynect.tool.pynect`);
  optionalBoolean(value, 'installPython', `${source}: pynect.tool.pynect`);
  optionalBoolean(value, 'installUv', `${source}: pynect.tool.pynect`);
  optionalBoolean(value, 'createVirtualEnvironment', `${source}: pynect.tool.pynect`);
  if (value['autoSync'] !== undefined) parseAutoSync(value['autoSync']);
  if (value['modules'] !== undefined) validateModules(value['modules'], source);
}

function validateRequirements(value: unknown, source: string): asserts value is string[] {
  stringArray(value, source);
  for (const requirement of value) {
    if (requirement.startsWith('-') || /[\0\r\n]/u.test(requirement)) {
      throw new TypeError(`${source}: unsafe Python requirement ${JSON.stringify(requirement)}.`);
    }
  }
}

function validateModules(value: unknown, source: string): void {
  if (!isRecord(value)) throw new TypeError(`${source}: pynect.modules must be an object.`);
  for (const [name, module] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(name)) {
      throw new TypeError(`${source}: invalid Pynect module alias ${JSON.stringify(name)}.`);
    }
    if (!isRecord(module) || typeof module['import'] !== 'string' ||
      !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(module['import'])) {
      throw new TypeError(`${source}: pynect.modules.${name}.import must be a Python module name.`);
    }
    if (module['include'] !== undefined) {
      stringArray(module['include'], `${source}: pynect.modules.${name}.include`);
    }
  }
}

function emptyCanonicalManifest(): CanonicalPynectPackageManifest {
  return {
    schemaVersion: CURRENT_PYNECT_SCHEMA_VERSION,
    project: {},
    tool: { uv: {}, pynect: {} },
  };
}

function mergeCanonicalManifests(
  base: CanonicalPynectPackageManifest,
  override: CanonicalPynectPackageManifest,
): CanonicalPynectPackageManifest {
  return {
    schemaVersion: CURRENT_PYNECT_SCHEMA_VERSION,
    project: { ...base.project, ...withoutUndefined(override.project) },
    tool: {
      uv: { ...base.tool.uv, ...withoutUndefined(override.tool.uv) },
      pynect: { ...base.tool.pynect, ...withoutUndefined(override.tool.pynect) },
    },
  };
}

function withoutUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined),
  ) as Partial<T>;
}

function defaultGeneratedDirectory(projectRoot: string): string {
  const installedPackage = resolveInstalledPackageDirectory(projectRoot, 'pynect');
  const installParent = installedPackage
    ? path.dirname(installedPackage)
    : path.join(projectRoot, 'node_modules');
  const localInstallParent = path.join(projectRoot, 'node_modules');
  if (pathsEqual(installParent, localInstallParent)) return path.join(installParent, '.pynect');
  const projectKey = createHash('sha256').update(path.resolve(projectRoot)).digest('hex').slice(0, 12);
  return path.join(installParent, '.pynect', projectKey);
}

function pathsEqual(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

export function resolveInstalledPackageDirectory(
  fromDirectory: string,
  packageName: string,
): string | undefined {
  let current = path.resolve(fromDirectory);
  while (true) {
    const candidate = path.join(current, 'node_modules', ...packageName.split('/'));
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function resolveInsideProject(projectRoot: string, value: string, fallback: string): string {
  const resolved = path.resolve(projectRoot, value || fallback);
  const relative = path.relative(projectRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new TypeError(`Pynect lockfile must be inside the project root: ${resolved}`);
  }
  return resolved;
}

function resolveBoolean(
  override: boolean | undefined,
  environment: string | undefined,
  manifest: boolean | undefined,
  fallback: boolean,
  name: string,
): boolean {
  if (override !== undefined) return override;
  if (environment !== undefined) return parseBoolean(environment, name);
  return manifest ?? fallback;
}

export function parseBoolean(value: string, name: string): boolean {
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  throw new TypeError(`${name} must be true or false; received ${value}.`);
}

function parseAutoSync(value: unknown): AutoSyncMode {
  if (value === 'never' || value === 'if-missing') return value;
  throw new TypeError(`autoSync must be "never" or "if-missing"; received ${String(value)}.`);
}

function optionalString(value: Record<string, unknown>, key: string, source: string): void {
  if (value[key] !== undefined && typeof value[key] !== 'string') {
    throw new TypeError(`${source}: pynect.${key} must be a string.`);
  }
}

function optionalBoolean(value: Record<string, unknown>, key: string, source: string): void {
  if (value[key] !== undefined && typeof value[key] !== 'boolean') {
    throw new TypeError(`${source}: pynect.${key} must be a boolean.`);
  }
}

function optionalRecord(
  value: Record<string, unknown>,
  key: string,
  source: string,
): Record<string, unknown> {
  const item = value[key];
  if (item === undefined) return {};
  if (!isRecord(item)) throw new TypeError(`${source}: pynect.${key} must be an object.`);
  return item;
}

function stringArray(value: unknown, source: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new TypeError(`${source} must be an array of non-empty strings.`);
  }
}

function first<T>(...values: Array<T | undefined>): T {
  return values.find(value => value !== undefined) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
