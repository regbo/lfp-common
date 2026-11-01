import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
  type SpawnSyncOptions,
} from 'node:child_process';
import {
  resolveOptions,
  uvEnvironment,
  type PyfigOptions,
  type ResolvedPyfigOptions,
} from './config.js';
import type { PackageManagerInfo, PythonInfo, UvInfo } from './probes.js';
import {
  assertMutationUsesUv,
  assertSafePackageArguments,
  isUvPipCommand,
  packageManagerEnvironment,
  uvPipEnvironment,
} from './package-target.js';
import {
  ensureEnvironment,
  ensureUv,
  ensureVirtualEnvironment,
  type PythonEnvironment,
} from './provision.js';
import { runtimeFile } from './runtime-files.js';
import { activateVirtualEnvironment } from './virtual-environment.js';

export interface ResolvedCommand {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

interface SyncResolutionRequest {
  target: 'python' | 'venv' | 'environment' | 'uv' | 'uv-pip';
  options: ResolvedPyfigOptions;
}

interface UvPipResolution {
  uv: UvInfo;
  python: PythonInfo;
}

export async function pythonSpawn(
  args: readonly string[] = [],
  spawnOptions: SpawnOptions = {},
  pyfigOptions: PyfigOptions = {},
): Promise<ChildProcess> {
  const options = optionsForInvocation(pyfigOptions, spawnOptions.env);
  const python = await ensureVirtualEnvironment(options);
  const command = buildPythonCommand(python, args, resolveOptions(options).env);
  return spawn(command.executable, command.args, {
    ...spawnOptions,
    env: command.env,
  });
}

export function pythonSpawnSync(
  args: readonly string[] = [],
  spawnOptions: SpawnSyncOptions = {},
  pyfigOptions: PyfigOptions = {},
): ReturnType<typeof spawnSync> {
  const options = optionsForInvocation(pyfigOptions, spawnOptions.env);
  const python = resolveSynchronously('venv', options);
  const command = buildPythonCommand(python, args, resolveOptions(options).env);
  return spawnSync(command.executable, command.args, {
    ...spawnOptions,
    env: command.env,
  });
}

export async function pipSpawn(
  args: readonly string[] = [],
  spawnOptions: SpawnOptions = {},
  pyfigOptions: PyfigOptions = {},
): Promise<ChildProcess> {
  const options = optionsForInvocation(pyfigOptions, spawnOptions.env);
  const environment = await ensureEnvironment(options);
  const command = buildPipCommand(
    environment.packageManager,
    args,
    resolveOptions(options).env,
  );
  return spawn(command.executable, command.args, {
    ...spawnOptions,
    env: command.env,
  });
}

export function pipSpawnSync(
  args: readonly string[] = [],
  spawnOptions: SpawnSyncOptions = {},
  pyfigOptions: PyfigOptions = {},
): ReturnType<typeof spawnSync> {
  const options = optionsForInvocation(pyfigOptions, spawnOptions.env);
  const environment = resolveSynchronously('environment', options);
  const command = buildPipCommand(
    environment.packageManager,
    args,
    resolveOptions(options).env,
  );
  return spawnSync(command.executable, command.args, {
    ...spawnOptions,
    env: command.env,
  });
}

export async function uvSpawn(
  args: readonly string[] = [],
  spawnOptions: SpawnOptions = {},
  pyfigOptions: PyfigOptions = {},
): Promise<ChildProcess> {
  const options = optionsForInvocation(pyfigOptions, spawnOptions.env);
  const resolved = resolveOptions(options);
  const uv = await ensureUv(resolved);
  const python = isUvPipCommand(args)
    ? await ensureVirtualEnvironment(resolved)
    : undefined;
  const command = buildUvCommand(uv, args, resolved, python);
  return spawn(command.executable, command.args, {
    ...spawnOptions,
    env: command.env,
  });
}

export function uvSpawnSync(
  args: readonly string[] = [],
  spawnOptions: SpawnSyncOptions = {},
  pyfigOptions: PyfigOptions = {},
): ReturnType<typeof spawnSync> {
  const options = optionsForInvocation(pyfigOptions, spawnOptions.env);
  const resolved = resolveOptions(options);
  const resolution = isUvPipCommand(args)
    ? resolveSynchronously('uv-pip', resolved)
    : { uv: resolveSynchronously('uv', resolved), python: undefined };
  const command = buildUvCommand(resolution.uv, args, resolved, resolution.python);
  return spawnSync(command.executable, command.args, {
    ...spawnOptions,
    env: command.env,
  });
}

export function buildPythonCommand(
  python: PythonInfo,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): ResolvedCommand {
  const commandEnv = python.virtualEnvironment
    ? activateVirtualEnvironment(env, python.virtualEnvironment, python.executable)
    : env;
  return {
    executable: python.executable,
    args: [...args],
    env: commandEnv,
  };
}

export function buildPipCommand(
  packageManager: PackageManagerInfo,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): ResolvedCommand {
  if (!packageManager.virtualEnvironment) {
    throw new Error('pip commands require an active virtual environment.');
  }
  assertSafePackageArguments(args);
  assertMutationUsesUv(packageManager, args);
  return {
    executable: packageManager.executable,
    args: [...packageManager.prefixArgs, ...args],
    env: packageManagerEnvironment(env, packageManager),
  };
}

export function buildUvCommand(
  uv: UvInfo,
  args: readonly string[],
  options: ResolvedPyfigOptions,
  python?: PythonInfo,
): ResolvedCommand {
  const isPip = isUvPipCommand(args);
  if (isPip && !python?.virtualEnvironment) {
    throw new Error('uv pip commands require the repo virtual-environment Python interpreter.');
  }
  if (isPip) assertSafePackageArguments(args);
  const env = isPip && python
    ? uvPipEnvironment(uvEnvironment(options), python)
    : uvEnvironment(options);
  return {
    executable: uv.executable,
    args: [...args],
    env,
  };
}

function optionsForInvocation(
  pyfigOptions: PyfigOptions,
  spawnEnv: NodeJS.ProcessEnv | undefined,
): PyfigOptions {
  return spawnEnv === undefined ? pyfigOptions : { ...pyfigOptions, env: spawnEnv };
}

function resolveSynchronously(
  target: 'python',
  options: PyfigOptions,
): PythonInfo;
function resolveSynchronously(
  target: 'venv',
  options: PyfigOptions,
): PythonInfo;
function resolveSynchronously(
  target: 'environment',
  options: PyfigOptions,
): PythonEnvironment;
function resolveSynchronously(
  target: 'uv',
  options: PyfigOptions,
): UvInfo;
function resolveSynchronously(
  target: 'uv-pip',
  options: PyfigOptions,
): UvPipResolution;
function resolveSynchronously(
  target: SyncResolutionRequest['target'],
  options: PyfigOptions,
): PythonInfo | PythonEnvironment | UvInfo | UvPipResolution {
  const resolved = resolveOptions(options);
  const request: SyncResolutionRequest = { target, options: resolved };
  const result = spawnSync(process.execPath, [runtimeFile('sync-resolver')], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    env: resolved.env,
    timeout: synchronousResolutionTimeout(resolved),
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0 || result.error) {
    const detail = result.stderr.trim() || result.error?.message || `exit ${result.status}`;
    throw new Error(`Could not resolve ${target} synchronously: ${detail}`);
  }
  try {
    return JSON.parse(result.stdout) as PythonInfo | PythonEnvironment | UvInfo | UvPipResolution;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse synchronous ${target} resolution: ${detail}`);
  }
}

function synchronousResolutionTimeout(options: ResolvedPyfigOptions): number {
  return options.coordinationTimeoutMs + options.downloadTimeoutMs +
    (2 * options.installTimeoutMs) + (4 * options.probeTimeoutMs) + 60_000;
}
