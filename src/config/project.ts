import fs from 'fs';
import path from 'path';
import {
  DEFAULT_MANAGED_PYTHON,
  DEFAULT_PYTHON_RANGE,
  DEFAULT_UV_VERSION,
  resolveProjectRoot,
} from 'pyfig';

export type AutoSyncMode = 'never' | 'if-missing';

export interface PynectModuleManifest {
  import: string;
  include?: string[];
}

export interface PynectPackageManifest {
  schemaVersion?: 1;
  requiresPython?: string;
  requirements?: string[];
  overrides?: Record<string, string>;
  modules?: Record<string, PynectModuleManifest>;
  python?: string;
  managedPython?: string;
  uvVersion?: string;
  installPython?: boolean;
  installUv?: boolean;
  createVirtualEnvironment?: boolean;
  autoSync?: AutoSyncMode;
  lockfile?: string;
}

export interface ProjectConfigOverrides {
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
  packageManifest: PynectPackageManifest;
  env: NodeJS.ProcessEnv;
}

const DEFAULTS = {
  python: '',
  requiresPython: DEFAULT_PYTHON_RANGE,
  managedPython: DEFAULT_MANAGED_PYTHON,
  uvVersion: DEFAULT_UV_VERSION,
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

  const python = first(overrides.python, env['PYNECT_PYTHON'], packageManifest.python, DEFAULTS.python);
  const requiresPython = first(
    overrides.requiresPython,
    env['PYNECT_REQUIRES_PYTHON'],
    packageManifest.requiresPython,
    DEFAULTS.requiresPython,
  );
  const configuredManagedPython = first(
    overrides.managedPython,
    env['PYNECT_MANAGED_PYTHON'],
    env['PYNECT_PYTHON_VERSION'],
    packageManifest.managedPython,
  );
  const managedPython = configuredManagedPython ?? DEFAULTS.managedPython;
  const uvVersion = first(
    overrides.uvVersion,
    env['PYNECT_UV_VERSION'],
    packageManifest.uvVersion,
    DEFAULTS.uvVersion,
  );
  const autoSync = parseAutoSync(first(
    overrides.autoSync,
    env['PYNECT_AUTO_SYNC'],
    packageManifest.autoSync,
    DEFAULTS.autoSync,
  ));
  const lockfile = first(
    overrides.lockfile,
    env['PYNECT_LOCKFILE'],
    packageManifest.lockfile,
    DEFAULTS.lockfile,
  );

  return {
    projectRoot,
    python,
    requiresPython,
    managedPython,
    managedPythonExplicit: configuredManagedPython !== undefined,
    uvVersion,
    installPython: resolveBoolean(
      overrides.installPython,
      env['PYNECT_INSTALL_PYTHON'] ?? env['PYNECT_AUTO_INSTALL'],
      packageManifest.installPython,
      DEFAULTS.installPython,
      'PYNECT_INSTALL_PYTHON',
    ),
    installUv: resolveBoolean(
      overrides.installUv,
      env['PYNECT_INSTALL_UV'],
      packageManifest.installUv,
      DEFAULTS.installUv,
      'PYNECT_INSTALL_UV',
    ),
    createVirtualEnvironment: resolveBoolean(
      overrides.createVirtualEnvironment,
      env['PYNECT_CREATE_VIRTUAL_ENVIRONMENT'],
      packageManifest.createVirtualEnvironment,
      DEFAULTS.createVirtualEnvironment,
      'PYNECT_CREATE_VIRTUAL_ENVIRONMENT',
    ),
    autoSync,
    lockfile: resolveInsideProject(projectRoot, lockfile, 'pynect.lock'),
    packageManifest,
    env,
  };
}

export function readRootPynectManifest(projectRoot: string): PynectPackageManifest {
  const packagePath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(packagePath)) return {};
  let contents: unknown;
  try {
    contents = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Unable to read ${packagePath}: ${(error as Error).message}`);
  }
  const value = (contents as { pynect?: unknown }).pynect;
  if (value === undefined) return {};
  return validatePackageManifest(value, packagePath);
}

export function validatePackageManifest(
  value: unknown,
  source: string,
): PynectPackageManifest {
  if (!isRecord(value)) throw new TypeError(`${source}: pynect must be an object.`);
  if (value['schemaVersion'] !== undefined && value['schemaVersion'] !== 1) {
    throw new TypeError(`${source}: pynect.schemaVersion must be 1.`);
  }
  optionalString(value, 'requiresPython', source);
  optionalString(value, 'python', source);
  optionalString(value, 'managedPython', source);
  optionalString(value, 'uvVersion', source);
  optionalString(value, 'lockfile', source);
  optionalBoolean(value, 'installPython', source);
  optionalBoolean(value, 'installUv', source);
  optionalBoolean(value, 'createVirtualEnvironment', source);
  if (value['autoSync'] !== undefined) parseAutoSync(value['autoSync']);
  if (value['requirements'] !== undefined) {
    stringArray(value['requirements'], `${source}: pynect.requirements`);
    for (const requirement of value['requirements']) {
      if (requirement.startsWith('-') || /[\0\r\n]/u.test(requirement)) {
        throw new TypeError(`${source}: unsafe Python requirement ${JSON.stringify(requirement)}.`);
      }
    }
  }
  if (value['modules'] !== undefined) validateModules(value['modules'], source);
  if (value['overrides'] !== undefined) validateOverrides(value['overrides'], source);
  return value as PynectPackageManifest;
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
