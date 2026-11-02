import fs from 'fs';
import path from 'path';
import {
  DEFAULT_MANAGED_PYTHON,
  DEFAULT_REQUIRES_UV,
  resolveProjectRoot,
} from 'pyfig';

export const CURRENT_PYNECT_SCHEMA_VERSION = 1 as const;
export const PYNECT_REQUIRES_PYTHON = '>=3.10.0 <4.0.0';

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

export interface PynectCallbackTable {
  maxDepth?: number;
}

export interface PynectToolTable {
  modules?: Record<string, PynectModuleManifest>;
  requirements?: string[];
  python?: string;
  managedPython?: string;
  requiresUv?: string;
  installPython?: boolean;
  installUv?: boolean;
  createVirtualEnvironment?: boolean;
  callbacks?: PynectCallbackTable;
}

export interface CanonicalPynectPackageManifest {
  schemaVersion: typeof CURRENT_PYNECT_SCHEMA_VERSION;
  project: PynectProjectTable;
  tool: {
    pynect: PynectToolTable;
  };
}

export interface PynectPackageManifest {
  /** Omit to use the latest schema understood by this Pynect version. */
  schemaVersion?: typeof CURRENT_PYNECT_SCHEMA_VERSION;
  project?: PynectProjectTable;
  tool?: {
    pynect?: PynectToolTable;
  };
}

export interface ProjectConfigOverrides extends PynectPackageManifest {
  projectRoot?: string;
  env?: Record<string, string | undefined>;
}

export interface ResolvedProjectConfig {
  projectRoot: string;
  python: string;
  requiresPython: string;
  requirements: string[];
  managedPython: string;
  managedPythonExplicit: boolean;
  requiresUv: string;
  installPython: boolean;
  installUv: boolean;
  createVirtualEnvironment: boolean;
  callbackMaxDepth?: number;
  packageManifest: CanonicalPynectPackageManifest;
  env: NodeJS.ProcessEnv;
}

const DEFAULTS = {
  python: '',
  requiresPython: PYNECT_REQUIRES_PYTHON,
  managedPython: DEFAULT_MANAGED_PYTHON,
  requiresUv: DEFAULT_REQUIRES_UV,
  installPython: true,
  installUv: true,
  createVirtualEnvironment: true,
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
    {
      schemaVersion: overrides.schemaVersion,
      project: overrides.project,
      tool: overrides.tool,
    },
    'Pynect API config',
  );
  const manifest = mergeCanonicalManifests(packageManifest, apiManifest);
  const project = manifest.project;
  const apiProject = apiManifest.project;
  const apiTool = apiManifest.tool.pynect;
  const packageTool = packageManifest.tool.pynect;

  const python = first(
    apiTool.python,
    env['PYNECT_PYTHON'],
    packageTool.python,
    DEFAULTS.python,
  );
  const requiresPython = first(
    apiProject['requires-python'],
    env['PYNECT_REQUIRES_PYTHON'],
    packageManifest.project['requires-python'],
    DEFAULTS.requiresPython,
  );
  const configuredManagedPython = first(
    apiTool.managedPython,
    env['PYNECT_MANAGED_PYTHON'],
    packageTool.managedPython,
  );
  const managedPython = configuredManagedPython ?? DEFAULTS.managedPython;
  const requiresUv = first(
    apiTool.requiresUv,
    env['PYNECT_REQUIRES_UV'],
    packageTool.requiresUv,
    DEFAULTS.requiresUv,
  );
  const requirements = first(
    apiTool.requirements,
    packageTool.requirements,
    [],
  ).map(requirement => path.resolve(projectRoot, requirement));
  const installPython = resolveBoolean(
    apiTool.installPython,
    env['PYNECT_INSTALL_PYTHON'],
    packageTool.installPython,
    DEFAULTS.installPython,
    'PYNECT_INSTALL_PYTHON',
  );
  const installUv = resolveBoolean(
    apiTool.installUv,
    env['PYNECT_INSTALL_UV'],
    packageTool.installUv,
    DEFAULTS.installUv,
    'PYNECT_INSTALL_UV',
  );
  const createVirtualEnvironment = resolveBoolean(
    apiTool.createVirtualEnvironment,
    env['PYNECT_CREATE_VIRTUAL_ENVIRONMENT'],
    packageTool.createVirtualEnvironment,
    DEFAULTS.createVirtualEnvironment,
    'PYNECT_CREATE_VIRTUAL_ENVIRONMENT',
  );
  const callbackMaxDepth = first(
    apiTool.callbacks?.maxDepth,
    parseOptionalPositiveInteger(env['PYNECT_CALLBACK_MAX_DEPTH'], 'PYNECT_CALLBACK_MAX_DEPTH'),
    packageTool.callbacks?.maxDepth,
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
      pynect: {
        modules: manifest.tool.pynect.modules ?? {},
        requirements: manifest.tool.pynect.requirements ?? [],
        python,
        managedPython,
        requiresUv,
        installPython,
        installUv,
        createVirtualEnvironment,
        callbacks: callbackMaxDepth === undefined ? undefined : { maxDepth: callbackMaxDepth },
      },
    },
  };

  return {
    projectRoot,
    python,
    requiresPython,
    requirements,
    managedPython,
    managedPythonExplicit: configuredManagedPython !== undefined,
    requiresUv,
    installPython,
    installUv,
    createVirtualEnvironment,
    callbackMaxDepth,
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
  assertKnownKeys(value, ['schemaVersion', 'project', 'tool'], `${source}: pynect`);

  const project = optionalRecord(value, 'project', source);
  assertKnownKeys(
    project,
    ['name', 'version', 'requires-python', 'dependencies'],
    `${source}: pynect.project`,
  );
  optionalString(project, 'name', `${source}: pynect.project`);
  optionalString(project, 'version', `${source}: pynect.project`);
  optionalString(project, 'requires-python', `${source}: pynect.project`);
  if (project['dependencies'] !== undefined) {
    validateRequirements(project['dependencies'], `${source}: pynect.project.dependencies`);
  }

  const toolTables = optionalRecord(value, 'tool', source);
  assertKnownKeys(toolTables, ['pynect'], `${source}: pynect.tool`);
  const pynectTool = optionalRecord(toolTables, 'pynect', `${source}: pynect.tool`);
  validatePynectTool(pynectTool, source);

  return {
    schemaVersion: CURRENT_PYNECT_SCHEMA_VERSION,
    project: {
      name: project['name'] as string | undefined,
      version: project['version'] as string | undefined,
      'requires-python': project['requires-python'] as string | undefined,
      dependencies: project['dependencies'] as string[] | undefined,
    },
    tool: {
      pynect: {
        modules: pynectTool['modules'] as Record<string, PynectModuleManifest> | undefined,
        requirements: pynectTool['requirements'] as string[] | undefined,
        python: pynectTool['python'] as string | undefined,
        managedPython: pynectTool['managedPython'] as string | undefined,
        requiresUv: pynectTool['requiresUv'] as string | undefined,
        installPython: pynectTool['installPython'] as boolean | undefined,
        installUv: pynectTool['installUv'] as boolean | undefined,
        createVirtualEnvironment: pynectTool['createVirtualEnvironment'] as boolean | undefined,
        callbacks: pynectTool['callbacks'] as PynectCallbackTable | undefined,
      },
    },
  };
}

function validatePynectTool(value: Record<string, unknown>, source: string): void {
  assertKnownKeys(value, [
    'modules',
    'requirements',
    'python',
    'managedPython',
    'requiresUv',
    'installPython',
    'installUv',
    'createVirtualEnvironment',
    'callbacks',
  ], `${source}: pynect.tool.pynect`);
  optionalString(value, 'python', `${source}: pynect.tool.pynect`);
  optionalString(value, 'managedPython', `${source}: pynect.tool.pynect`);
  optionalString(value, 'requiresUv', `${source}: pynect.tool.pynect`);
  optionalBoolean(value, 'installPython', `${source}: pynect.tool.pynect`);
  optionalBoolean(value, 'installUv', `${source}: pynect.tool.pynect`);
  optionalBoolean(value, 'createVirtualEnvironment', `${source}: pynect.tool.pynect`);
  if (value['requirements'] !== undefined) {
    validateRequirements(value['requirements'], `${source}: pynect.tool.pynect.requirements`);
  }
  if (value['modules'] !== undefined) validateModules(value['modules'], source);
  if (value['callbacks'] !== undefined) {
    const callbacks = optionalRecord(value, 'callbacks', `${source}: pynect.tool.pynect`);
    assertKnownKeys(callbacks, ['maxDepth'], `${source}: pynect.tool.pynect.callbacks`);
    if (callbacks['maxDepth'] !== undefined &&
      (!Number.isSafeInteger(callbacks['maxDepth']) || (callbacks['maxDepth'] as number) <= 0)) {
      throw new TypeError(`${source}: pynect.tool.pynect.callbacks.maxDepth must be a positive integer.`);
    }
  }
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
    assertKnownKeys(module, ['import', 'include'], `${source}: pynect.modules.${name}`);
    if (module['include'] !== undefined) {
      stringArray(module['include'], `${source}: pynect.modules.${name}.include`);
    }
  }
}

function emptyCanonicalManifest(): CanonicalPynectPackageManifest {
  return {
    schemaVersion: CURRENT_PYNECT_SCHEMA_VERSION,
    project: {},
    tool: { pynect: {} },
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
      pynect: { ...base.tool.pynect, ...withoutUndefined(override.tool.pynect) },
    },
  };
}

function withoutUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined),
  ) as Partial<T>;
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

function parseOptionalPositiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${name} must be a positive integer; received ${value}.`);
  }
  return parsed;
}

function optionalString(value: Record<string, unknown>, key: string, source: string): void {
  if (value[key] !== undefined && typeof value[key] !== 'string') {
    throw new TypeError(`${source}: pynect.${key} must be a string.`);
  }
}

function assertKnownKeys(
  value: Record<string, unknown>,
  known: readonly string[],
  source: string,
): void {
  const unknown = Object.keys(value).filter(key => !known.includes(key));
  if (unknown.length > 0) {
    throw new TypeError(`${source} contains unknown field(s): ${unknown.join(', ')}.`);
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
