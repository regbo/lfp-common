import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
  type SpawnSyncOptions,
} from 'node:child_process';
import {
  resolveOptions,
  uvProcessEnvironment,
  type PyfigOptions,
  type ResolvedPyfigOptions,
} from './config.js';
import type { PythonInfo, UvInfo } from './probes.js';
import {
  targetUvArguments,
  uvCommandNeedsPython,
  uvCommandProcessEnvironment,
} from './package-target.js';
import { ensurePython, ensureUv, type PythonEnvironment } from './provision.js';
import { runtimeFile } from './runtime-files.js';

export interface ResolvedCommand {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

interface SyncResolutionRequest {
  target: 'python' | 'uv';
  options: ResolvedPyfigOptions;
}

/** Run uv, pinning uv pip and uv run to Pyfig's selected environment. */
export async function uvSpawn(
  args: readonly string[] = [],
  spawnOptions: SpawnOptions = {},
  pyfigOptions: PyfigOptions = {},
): Promise<ChildProcess> {
  const options = optionsForInvocation(pyfigOptions, spawnOptions.env);
  const resolved = resolveOptions(options);
  const python = uvCommandNeedsPython(args)
    ? await ensurePython(resolved)
    : undefined;
  const uv = python?.uv ?? await ensureUv(resolved);
  const command = buildUvCommand(uv, args, resolved, python?.python);
  return spawn(command.executable, command.args, {
    ...spawnOptions,
    env: command.env,
  });
}

/** Synchronous counterpart to uvSpawn for build and CommonJS hooks. */
export function uvSpawnSync(
  args: readonly string[] = [],
  spawnOptions: SpawnSyncOptions = {},
  pyfigOptions: PyfigOptions = {},
): ReturnType<typeof spawnSync> {
  const options = optionsForInvocation(pyfigOptions, spawnOptions.env);
  const resolved = resolveOptions(options);
  const python = uvCommandNeedsPython(args)
    ? resolveSynchronously('python', resolved)
    : undefined;
  const uv = python?.uv ?? resolveSynchronously('uv', resolved);
  const command = buildUvCommand(uv, args, resolved, python?.python);
  return spawnSync(command.executable, command.args, {
    ...spawnOptions,
    env: command.env,
  });
}

export function buildUvCommand(
  uv: UvInfo,
  args: readonly string[],
  options: ResolvedPyfigOptions,
  python?: PythonInfo,
): ResolvedCommand {
  return {
    executable: uv.executable,
    args: python ? targetUvArguments(args, python) : [...args],
    env: uvCommandProcessEnvironment(uvProcessEnvironment(options), python),
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
): PythonEnvironment;
function resolveSynchronously(target: 'uv', options: PyfigOptions): UvInfo;
function resolveSynchronously(
  target: SyncResolutionRequest['target'],
  options: PyfigOptions,
): PythonEnvironment | UvInfo {
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
    return JSON.parse(result.stdout) as PythonEnvironment | UvInfo;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse synchronous ${target} resolution: ${detail}`);
  }
}

function synchronousResolutionTimeout(options: ResolvedPyfigOptions): number {
  return options.coordinationTimeoutMs + options.downloadTimeoutMs +
    (2 * options.installTimeoutMs) + (4 * options.probeTimeoutMs) + 60_000;
}
