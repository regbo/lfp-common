import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  maxSatisfying,
  valid as validVersion,
  validRange,
} from '@renovatebot/pep440';
import { memoize } from 'loqkit';
import { z } from 'zod';
import { createDebugLogger, type DebugLogger } from './logging.js';
import {
  capture,
  CapturedProcessError,
  environmentValue,
  findExecutable,
  mergeEnvironment,
  spawnCommand,
  splitSpawnArguments,
  waitForPromise,
  type SpawnArgument,
} from './process.js';
import { resolveUv } from './uv.js';

export const DEFAULT_UV = '>=0.10,<1';

const ASTRAL_PYTHON_INSTALL_MIRROR =
  'https://releases.astral.sh/github/python-build-standalone/releases/download';
const CUSTOM_PYTHON_SOURCE_ENVIRONMENT = [
  'UV_ASTRAL_MIRROR_URL',
  'UV_PYTHON_DOWNLOADS_JSON_URL',
  'UV_PYTHON_INSTALL_MIRROR',
] as const;
const GITHUB_PYTHON_RELEASE = /github\.com\/astral-sh\/python-build-standalone\/releases\/download/iu;
const OLD_UV_RANGE = '<0.11';
const PYTHON_FIND_ATTEMPTS = [
  { args: [], name: 'default' },
  { args: ['--managed-python', '--no-python-downloads'], name: 'installed managed' },
  { args: ['--no-managed-python', '--no-python-downloads'], name: 'system' },
] as const;
const PYTHON_PROBE = 'import sys; print(sys.executable)';

export const pyfigOptionsSchema = z.object({
  uv: z.string()
    .trim()
    .min(1, 'uv must not be empty.')
    .default(DEFAULT_UV)
    .describe('uv executable or PEP 440 constraint. Executables take precedence.'),
  python: z.string()
    .min(1, 'python must not be empty.')
    .refine(value => value.trim().length > 0, 'python must not be empty.')
    .optional()
    .describe('Python request passed unchanged to uv when Python is first spawned.'),
  debug: z.boolean()
    .default(false)
    .describe('Write resolution, download, and provisioning diagnostics to stderr.'),
  cwd: z.string()
    .trim()
    .min(1, 'cwd must not be empty.')
    .default(() => process.cwd())
    .describe('Directory used for uv project and configuration discovery.'),
  env: z.union([
    z.record(z.string(), z.string().optional()),
    z.string().transform(value => {
      const parsed: unknown = JSON.parse(value);
      return z.record(z.string(), z.string().optional()).parse(parsed);
    }),
  ])
    .optional()
    .describe('Environment overrides used during executable resolution and provisioning.'),
}).readonly().describe('Options for resolving uv and creating a lazy Python runtime context.');

export type PyfigOptions = z.input<typeof pyfigOptionsSchema>;
export type UvSource = 'cache' | 'download' | 'explicit' | 'path';

export interface UvExecutable {
  /** Absolute path to the resolved uv executable. */
  readonly path: string;
  /** How uv was selected or obtained. */
  readonly source: UvSource;
  /** PEP 440-compatible uv version. */
  readonly version: string;
  /** Start uv with context defaults and optional Node spawn overrides. */
  spawn(...args: string[]): Promise<ChildProcess>;
  spawn(...args: [...string[], SpawnOptions]): Promise<ChildProcess>;
}

export interface PythonExecutable {
  /** Resolve Python privately, then execute it through uv run. */
  spawn(...args: string[]): Promise<ChildProcess>;
  spawn(...args: [...string[], SpawnOptions]): Promise<ChildProcess>;
}

interface RuntimeDefaults {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly log: DebugLogger;
}

interface UvMetadata {
  readonly path: string;
  readonly source: UvSource;
  readonly version: string;
}

interface PythonResolution {
  readonly executable: string;
}

interface PythonRuntimeDefaults extends RuntimeDefaults {
  readonly pythonRequest: string | undefined;
  readonly uvPath: string;
  readonly uvVersion: string;
}

class ResolvedUv implements UvExecutable {
  readonly path: string;
  readonly source: UvSource;
  readonly version: string;
  readonly #defaults: RuntimeDefaults;

  constructor(metadata: UvMetadata, defaults: RuntimeDefaults) {
    this.path = metadata.path;
    this.source = metadata.source;
    this.version = metadata.version;
    this.#defaults = defaults;
    Object.freeze(this);
  }

  async spawn(...values: SpawnArgument[]): Promise<ChildProcess> {
    const { args, options } = splitSpawnArguments(values);
    options.signal?.throwIfAborted();
    return spawnCommand(this.path, args, this.#defaults.cwd, this.#defaults.env, options);
  }
}

class LazyPython implements PythonExecutable {
  readonly #defaults: PythonRuntimeDefaults;
  readonly #resolve: () => Promise<PythonResolution>;

  constructor(defaults: PythonRuntimeDefaults) {
    this.#defaults = defaults;
    // Loqkit shares in-flight work and successful results, while rejected
    // resolutions remain retryable after transient network or policy failures.
    this.#resolve = memoize(() => resolvePython(defaults));
    Object.freeze(this);
  }

  async spawn(...values: SpawnArgument[]): Promise<ChildProcess> {
    const { args, options } = splitSpawnArguments(values);
    options.signal?.throwIfAborted();
    const hasRuntimeOverrides = options.cwd !== undefined || options.env !== undefined;
    const resolution = hasRuntimeOverrides
      ? resolvePython(runtimeDefaultsForSpawn(this.#defaults, options), options.signal)
      : waitForPromise(this.#resolve(), options.signal);
    const resolved = await resolution;
    const childOptions: SpawnOptions = {
      ...options,
      env: mergeEnvironment(options.env ?? {}, { UV_PYTHON: resolved.executable }),
    };
    return spawnCommand(
      this.#defaults.uvPath,
      ['run', '--', 'python', ...args],
      this.#defaults.cwd,
      this.#defaults.env,
      childOptions,
    );
  }
}

export class PythonContext {
  /** Resolved uv executable metadata and raw spawn helper. */
  readonly uv: UvExecutable;
  /** Python execution through uv; interpreter metadata remains private. */
  readonly python: PythonExecutable;

  constructor(uv: UvExecutable, python: PythonExecutable) {
    this.uv = uv;
    this.python = python;
    Object.freeze(this);
  }
}

/** Resolve or provision uv and return a context that delegates Python to uv. */
export async function pyfig(options: PyfigOptions = {}): Promise<PythonContext> {
  const parsedOptions = pyfigOptionsSchema.parse(options);
  const log = createDebugLogger(parsedOptions.debug);
  const env = mergeEnvironment(process.env, parsedOptions.env);
  const cwd = path.resolve(parsedOptions.cwd);
  log('Resolving runtime context.', {
    cwd,
    python: parsedOptions.python ?? 'uv default',
    uv: parsedOptions.uv,
  });
  const uvMetadata = await selectUv(parsedOptions.uv, cwd, env, log);
  log('Resolved uv.', uvMetadata);

  const defaults = { cwd, env, log };
  return new PythonContext(
    new ResolvedUv(uvMetadata, defaults),
    new LazyPython({
      ...defaults,
      pythonRequest: parsedOptions.python,
      uvPath: uvMetadata.path,
      uvVersion: uvMetadata.version,
    }),
  );
}

interface Selection {
  executable: string | null;
  specifier: string | null;
}

async function selectUv(
  request: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  log: DebugLogger,
): Promise<UvMetadata> {
  const selection = await uvExecutableOrSpecifier(request, cwd, env);
  if (selection.executable) {
    log('Using requested uv executable.', { path: selection.executable });
    return { ...await probeUv(selection.executable, cwd, env), source: 'explicit' };
  }
  const specifier = selection.specifier;
  if (!specifier) throw new Error('uv selection did not contain a version specifier.');
  log('Resolving uv version constraint.', { specifier });
  const resolved = await resolveUv(specifier, cwd, env, log);
  return { ...await probeUv(resolved.path, cwd, env), source: resolved.source };
}

async function resolvePython(
  defaults: PythonRuntimeDefaults,
  signal?: AbortSignal,
): Promise<PythonResolution> {
  try {
    return await resolvePythonWithUv(defaults, defaults.env, signal);
  } catch (primaryError) {
    if (!shouldUseAstralFallback(defaults, primaryError)) throw primaryError;
    defaults.log('uv could not download Python from GitHub; retrying through Astral.', {
      uvVersion: defaults.uvVersion,
    });
    const fallbackEnvironment = mergeEnvironment(defaults.env, {
      UV_PYTHON_INSTALL_MIRROR: ASTRAL_PYTHON_INSTALL_MIRROR,
    });
    try {
      return await resolvePythonWithUv(defaults, fallbackEnvironment, signal);
    } catch (fallbackError) {
      throw new AggregateError(
        [primaryError, fallbackError],
        'uv could not resolve Python from its default source or the Astral fallback.',
      );
    }
  }
}

async function resolvePythonWithUv(
  defaults: PythonRuntimeDefaults,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<PythonResolution> {
  const failures: Error[] = [];
  for (const attempt of PYTHON_FIND_ATTEMPTS) {
    try {
      const executable = await findPython(defaults, env, attempt.args, signal);
      return await runPythonProbe(defaults, env, ['--python', executable], signal, [executable]);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      failures.push(failure);
      defaults.log('Python candidate selected by uv was unusable.', {
        attempt: attempt.name,
        error: failure.message,
      });
    }
  }

  try {
    const runArguments = ['--managed-python'];
    if (defaults.pythonRequest !== undefined) {
      runArguments.push('--python', defaults.pythonRequest);
    }
    return await runPythonProbe(
      defaults,
      env,
      runArguments,
      signal,
      pythonRequestRedactions(defaults.pythonRequest),
    );
  } catch (error) {
    failures.push(error instanceof Error ? error : new Error(String(error)));
    throw new AggregateError(failures, 'uv could not resolve a usable Python interpreter.');
  }
}

async function findPython(
  defaults: PythonRuntimeDefaults,
  env: NodeJS.ProcessEnv,
  findArguments: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  const args = ['python', 'find', ...findArguments];
  if (defaults.pythonRequest !== undefined) args.push('--', defaults.pythonRequest);
  const output = await capture(defaults.uvPath, args, defaults.cwd, env, {
    redact: pythonRequestRedactions(defaults.pythonRequest),
    signal,
  });
  const executable = output.trim().split(/\r?\n/u).at(-1) ?? '';
  if (!path.isAbsolute(executable)) {
    throw new Error('uv did not report an absolute Python path.');
  }
  return path.normalize(executable);
}

async function runPythonProbe(
  defaults: PythonRuntimeDefaults,
  env: NodeJS.ProcessEnv,
  runArguments: readonly string[],
  signal: AbortSignal | undefined,
  redact: readonly string[],
): Promise<PythonResolution> {
  const args = ['run', ...runArguments, '--', 'python', '-I', '-S', '-c', PYTHON_PROBE];
  const output = await capture(defaults.uvPath, args, defaults.cwd, env, { redact, signal });
  const executable = output.trim().split(/\r?\n/u).at(-1) ?? '';
  if (!path.isAbsolute(executable)) {
    throw new Error('Python selected by uv returned incomplete metadata.');
  }
  defaults.log('Resolved Python through uv.');
  return { executable: path.normalize(executable) };
}

function shouldUseAstralFallback(
  defaults: PythonRuntimeDefaults,
  error: unknown,
): boolean {
  if (!maxSatisfying([defaults.uvVersion], OLD_UV_RANGE)) return false;
  if (CUSTOM_PYTHON_SOURCE_ENVIRONMENT.some(name => environmentValue(defaults.env, name))) {
    return false;
  }
  return githubPythonDownloadFailed(error);
}

function githubPythonDownloadFailed(error: unknown): boolean {
  if (error instanceof CapturedProcessError) {
    return GITHUB_PYTHON_RELEASE.test(`${error.stderr}\n${error.stdout}\n${error.message}`);
  }
  if (error instanceof AggregateError) {
    return error.errors.some(githubPythonDownloadFailed);
  }
  return false;
}

async function probeUv(
  executable: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<Omit<UvMetadata, 'source'>> {
  const output = await capture(executable, ['--version'], cwd, env);
  const version = validVersion(output.trim().match(/^uv\s+(\S+)/iu)?.[1] ?? '');
  if (!version) {
    throw new Error(`${JSON.stringify(executable)} did not report a valid uv version.`);
  }
  return { path: path.normalize(executable), version };
}

async function uvExecutableOrSpecifier(
  value: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<Selection> {
  assertNonempty('uv', value);
  const pathLike = path.isAbsolute(value) || /[\\/]/u.test(value);
  if (!pathLike && validRange(value)) return { executable: null, specifier: value };
  const executable = await findExecutable(value, cwd, env);
  if (executable) return { executable, specifier: null };
  if (validRange(value)) return { executable: null, specifier: value };
  throw new TypeError(
    `uv must resolve to an executable or be a valid PEP 440 specifier, received ${JSON.stringify(value)}.`,
  );
}

function runtimeDefaultsForSpawn(
  defaults: PythonRuntimeDefaults,
  options: SpawnOptions,
): PythonRuntimeDefaults {
  const cwd = options.cwd === undefined
      ? defaults.cwd
      : typeof options.cwd === 'string'
        ? path.resolve(options.cwd)
        : fileURLToPath(options.cwd);
  return {
    ...defaults,
    cwd,
    env: mergeEnvironment(defaults.env, options.env),
  };
}

function pythonRequestRedactions(request: string | undefined): string[] {
  return request && (path.isAbsolute(request) || /[\\/]/u.test(request)) ? [request] : [];
}

function assertNonempty(name: string, value: string): void {
  if (value.trim() === '') throw new TypeError(`${name} must not be empty.`);
}
