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

/** A scoped uv-first Python runtime with one consistent environment policy. */
export class Python {
  readonly #options: PyfigOptions;
  readonly #environment: () => Promise<PythonEnvironment>;
  readonly #uvInfo: () => Promise<UvInfo>;

  constructor(options: PyfigOptions = {}) {
    this.#options = {
      ...options,
      dependencies: options.dependencies ? [...options.dependencies] : undefined,
      requirements: options.requirements ? [...options.requirements] : undefined,
      env: options.env ? { ...options.env } : undefined,
    };
    this.#environment = memoize(() => ensureEnvironment(this.#options));
    this.#uvInfo = memoize(() => ensureUv(this.#options));
  }

  prepare(): Promise<PythonEnvironment> {
    return this.#environment();
  }

  async pythonInfo(): Promise<PythonInfo> {
    return (await this.#environment()).python;
  }

  uvInfo(): Promise<UvInfo> {
    return this.#uvInfo();
  }

  uv(args: readonly string[] = [], options: SpawnOptions = {}): Promise<ChildProcess> {
    return uvSpawn(args, options, this.#options);
  }

  uvSync(
    args?: readonly string[],
    options?: SpawnSyncOptions,
  ): ReturnType<typeof spawnSync> {
    return uvSpawnSync(args, options, this.#options);
  }
}
