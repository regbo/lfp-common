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
  type RuntimeDependencyOptions,
} from './provision.js';
import { uvSpawn, uvSpawnSync } from './runners.js';

/** A scoped uv-first API with one consistent environment policy. */
export interface PyfigClient {
  prepare(
    requirements?: readonly string[],
    options?: RuntimeDependencyOptions,
  ): Promise<PythonEnvironment>;
  pythonInfo(): Promise<PythonInfo>;
  uvInfo(): Promise<UvInfo>;
  uv(args?: readonly string[], options?: SpawnOptions): Promise<ChildProcess>;
  uvSync(
    args?: readonly string[],
    options?: SpawnSyncOptions,
  ): ReturnType<typeof spawnSync>;
}

/** Bind configuration once so consumers cannot accidentally diverge between calls. */
export function createPyfig(options: PyfigOptions = {}): PyfigClient {
  const scopedOptions: PyfigOptions = {
    ...options,
    env: options.env ? { ...options.env } : undefined,
  };
  const baseEnvironment = memoize(() => ensureEnvironment(scopedOptions));
  const uvInfo = memoize(() => ensureUv(scopedOptions));
  return {
    prepare: (requirements = [], dependencyOptions = {}) => requirements.length === 0 &&
      !dependencyOptions.allExtras &&
      (dependencyOptions.extras?.length ?? 0) === 0 &&
      (dependencyOptions.groups?.length ?? 0) === 0
      ? baseEnvironment()
      : ensureEnvironment(scopedOptions, requirements, dependencyOptions),
    pythonInfo: async () => (await baseEnvironment()).python,
    uvInfo,
    uv: (args = [], spawnOptions = {}) => uvSpawn(args, spawnOptions, scopedOptions),
    uvSync: (args = [], spawnOptions = {}) => uvSpawnSync(args, spawnOptions, scopedOptions),
  };
}
