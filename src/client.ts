import type {
  ChildProcess,
  SpawnOptions,
  SpawnSyncOptions,
  spawnSync,
} from 'node:child_process';
import { memoize } from 'loqkit';
import type { PyfigOptions } from './config.js';
import type { PythonInfo, UvInfo } from './probes.js';
import {
  ensureEnvironment,
  ensureUv,
  type PythonEnvironment,
} from './provision.js';
import { uvSpawn, uvSpawnSync } from './runners.js';

/** A scoped uv-first API with one consistent environment policy. */
export interface PyEnvironmentClient {
  prepare(): Promise<PythonEnvironment>;
  pythonInfo(): Promise<PythonInfo>;
  uvInfo(): Promise<UvInfo>;
  uv(args?: readonly string[], options?: SpawnOptions): Promise<ChildProcess>;
  uvSync(
    args?: readonly string[],
    options?: SpawnSyncOptions,
  ): ReturnType<typeof spawnSync>;
}

/** Bind configuration once so consumers cannot accidentally diverge between calls. */
export function createPyEnvironment(options: PyfigOptions = {}): PyEnvironmentClient {
  const scopedOptions: PyfigOptions = {
    ...options,
    dependencies: options.dependencies ? [...options.dependencies] : undefined,
    extras: options.extras ? [...options.extras] : undefined,
    groups: options.groups ? [...options.groups] : undefined,
    env: options.env ? { ...options.env } : undefined,
  };
  const environment = memoize(() => ensureEnvironment(scopedOptions));
  const uvInfo = memoize(() => ensureUv(scopedOptions));
  return {
    prepare: environment,
    pythonInfo: async () => (await environment()).python,
    uvInfo,
    uv: (args = [], spawnOptions = {}) => uvSpawn(args, spawnOptions, scopedOptions),
    uvSync: (args = [], spawnOptions = {}) => uvSpawnSync(args, spawnOptions, scopedOptions),
  };
}
