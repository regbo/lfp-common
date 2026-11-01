import type {
  ChildProcess,
  SpawnOptions,
  SpawnSyncOptions,
  spawnSync,
} from 'node:child_process';
import type { PyfigOptions } from './config.js';
import type { PythonInfo, UvInfo } from './probes.js';
import {
  ensureEnvironment,
  ensureUv,
  ensureVirtualEnvironment,
  type PythonEnvironment,
} from './provision.js';
import {
  pipSpawn,
  pipSpawnSync,
  pythonSpawn,
  pythonSpawnSync,
  uvSpawn,
  uvSpawnSync,
} from './runners.js';
import { clearPyfigCaches } from './state.js';

/** A scoped Pyfig API that keeps one policy object consistent across every operation. */
export interface PyfigClient {
  prepare(): Promise<PythonEnvironment>;
  pythonInfo(): Promise<PythonInfo>;
  uvInfo(): Promise<UvInfo>;
  python(args?: readonly string[], options?: SpawnOptions): Promise<ChildProcess>;
  pythonSync(
    args?: readonly string[],
    options?: SpawnSyncOptions,
  ): ReturnType<typeof spawnSync>;
  pip(args?: readonly string[], options?: SpawnOptions): Promise<ChildProcess>;
  pipSync(
    args?: readonly string[],
    options?: SpawnSyncOptions,
  ): ReturnType<typeof spawnSync>;
  uv(args?: readonly string[], options?: SpawnOptions): Promise<ChildProcess>;
  uvSync(
    args?: readonly string[],
    options?: SpawnSyncOptions,
  ): ReturnType<typeof spawnSync>;
  clearCache(): void;
}

/** Bind configuration once so consumers cannot accidentally diverge between calls. */
export function createPyfig(options: PyfigOptions = {}): PyfigClient {
  const scopedOptions: PyfigOptions = {
    ...options,
    env: options.env ? { ...options.env } : undefined,
  };
  return {
    prepare: () => ensureEnvironment(scopedOptions),
    pythonInfo: () => ensureVirtualEnvironment(scopedOptions),
    uvInfo: () => ensureUv(scopedOptions),
    python: (args = [], spawnOptions = {}) => pythonSpawn(args, spawnOptions, scopedOptions),
    pythonSync: (args = [], spawnOptions = {}) => pythonSpawnSync(args, spawnOptions, scopedOptions),
    pip: (args = [], spawnOptions = {}) => pipSpawn(args, spawnOptions, scopedOptions),
    pipSync: (args = [], spawnOptions = {}) => pipSpawnSync(args, spawnOptions, scopedOptions),
    uv: (args = [], spawnOptions = {}) => uvSpawn(args, spawnOptions, scopedOptions),
    uvSync: (args = [], spawnOptions = {}) => uvSpawnSync(args, spawnOptions, scopedOptions),
    clearCache: clearPyfigCaches,
  };
}
