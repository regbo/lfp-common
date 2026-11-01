import os from 'node:os';
import type { PackageManagerInfo, PythonInfo } from './probes.js';
import { activateVirtualEnvironment } from './virtual-environment.js';

const TARGET_CHANGING_OPTIONS = new Set([
  '--config-file',
  '--prefix',
  '--python',
  '--root',
  '--system',
  '--target',
  '--user',
]);

const TARGET_CHANGING_SHORT_OPTIONS = new Set(['-p', '-t']);

const TARGET_ENVIRONMENT_VARIABLES = new Set([
  'CONDA_PREFIX',
  'PIP_CONFIG_FILE',
  'PIP_PREFIX',
  'PIP_PYTHON',
  'PIP_ROOT',
  'PIP_TARGET',
  'PIP_USER',
  'PYTHONHOME',
  'PYTHONUSERBASE',
  'UV_CONFIG_FILE',
  'UV_PROJECT_ENVIRONMENT',
  'UV_PREFIX',
  'UV_PYTHON',
  'UV_ROOT',
  'UV_SYSTEM_PYTHON',
  'UV_TARGET',
]);

/** Reject package-manager arguments that can escape the selected repository venv. */
export function assertSafePackageArguments(args: readonly string[]): void {
  for (const argument of args) {
    if (argument === '--') break;
    const [name] = argument.split('=', 1);
    if (name && TARGET_CHANGING_OPTIONS.has(name)) {
      throw new Error(
        `${name} is not allowed because Pyfig package commands are pinned to the repository .venv.`,
      );
    }
    const shortName = argument.slice(0, 2);
    if (TARGET_CHANGING_SHORT_OPTIONS.has(shortName)) {
      throw new Error(
        `${shortName} is not allowed because Pyfig package commands are pinned to the repository .venv.`,
      );
    }
  }
}

/** Build a package-manager environment whose target cannot be inherited or configured elsewhere. */
export function packageManagerEnvironment(
  env: NodeJS.ProcessEnv,
  packageManager: PackageManagerInfo,
): NodeJS.ProcessEnv {
  const active = sanitizedTargetEnvironment(env);
  const activated = activateVirtualEnvironment(
    active,
    packageManager.virtualEnvironment,
    packageManager.pythonExecutable,
  );
  return packageManager.kind === 'uv'
    ? {
        ...activated,
        UV_NO_CONFIG: '1',
        UV_PYTHON: packageManager.pythonExecutable,
      }
    : {
        ...activated,
        PIP_CONFIG_FILE: os.devNull,
        PIP_REQUIRE_VIRTUALENV: '1',
        PYTHONNOUSERSITE: '1',
      };
}

/** Apply the same strict target policy to a direct `uv pip` invocation. */
export function uvPipEnvironment(
  env: NodeJS.ProcessEnv,
  python: PythonInfo,
): NodeJS.ProcessEnv {
  if (!python.virtualEnvironment) {
    throw new Error('uv pip commands require the repository virtual environment.');
  }
  return {
    ...activateVirtualEnvironment(
      sanitizedTargetEnvironment(env),
      python.virtualEnvironment,
      python.executable,
    ),
    UV_NO_CONFIG: '1',
    UV_PYTHON: python.executable,
  };
}

/** Package installation and removal must use uv so its target-environment lock is authoritative. */
export function assertMutationUsesUv(
  packageManager: PackageManagerInfo,
  args: readonly string[],
): void {
  if (packageManager.kind === 'pip' && isPackageMutation(args)) {
    throw new Error(
      'Package mutation requires uv so the repository environment is locked across processes. ' +
      'Enable uv installation or use a read-only pip command.',
    );
  }
}

export function isPackageMutation(args: readonly string[]): boolean {
  return args.some((argument) =>
    argument === 'install' || argument === 'sync' || argument === 'uninstall');
}

export function isUvPipCommand(args: readonly string[]): boolean {
  const separator = args.indexOf('--');
  const commandArguments = separator === -1 ? args : args.slice(0, separator);
  return commandArguments.includes('pip');
}

function sanitizedTargetEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  for (const key of Object.keys(sanitized)) {
    if (TARGET_ENVIRONMENT_VARIABLES.has(key.toUpperCase())) delete sanitized[key];
  }
  return sanitized;
}
