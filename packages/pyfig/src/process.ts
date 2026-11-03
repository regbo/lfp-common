import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import which from 'which';

const OUTPUT_LIMIT = 1024 * 1024;

export type SpawnArgument = SpawnOptions | string;

interface CaptureOptions {
  /** Values removed from surfaced errors while retaining raw successful output. */
  readonly redact?: readonly string[];
  readonly signal?: AbortSignal;
}

/** Error details retained from a bounded subprocess capture. */
export class CapturedProcessError extends Error {
  readonly stderr: string;
  readonly stdout: string;

  constructor(
    message: string,
    details: {
      stderr: string;
      stdout: string;
    },
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CapturedProcessError';
    this.stderr = details.stderr;
    this.stdout = details.stdout;
  }
}

/** Resolve a command name or path to an executable without invoking it. */
export async function findExecutable(
  requested: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const candidate = path.isAbsolute(requested) || /[\\/]/u.test(requested)
    ? path.resolve(cwd, requested)
    : requested;
  const resolved = await which(candidate, {
    nothrow: true,
    path: environmentValue(env, 'PATH'),
    pathExt: environmentValue(env, 'PATHEXT'),
  });
  return resolved ? path.resolve(cwd, resolved) : null;
}

/** Yield matching executable files in PATH order without scanning ahead. */
export async function* findExecutables(
  names: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): AsyncGenerator<string, void, undefined> {
  const directories = (environmentValue(env, 'PATH') ?? '')
    .split(path.delimiter)
    .filter(Boolean);
  const extensions = process.platform === 'win32'
    ? (environmentValue(env, 'PATHEXT') ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  const seen = new Set<string>();
  for (const directory of directories) {
    for (const name of names) {
      const hasExtension = path.extname(name).length > 0;
      for (const extension of hasExtension ? [''] : extensions) {
        // Relative PATH entries are interpreted from the child working
        // directory, not necessarily from the parent Node process directory.
        const candidate = path.resolve(cwd, directory, `${name}${extension}`);
        const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          await access(candidate);
          yield candidate;
        } catch {
          // Missing and inaccessible PATH entries are not executable candidates.
        }
      }
    }
  }
}

/** Capture a bounded child-process response or throw with its stderr. */
export async function capture(
  executable: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  options: CaptureOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      signal: options.signal,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(stdout);
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > OUTPUT_LIMIT) {
        child.kill();
        finish(capturedProcessError(
          `${path.basename(executable)} exceeded its stdout limit.`,
          stdout,
          stderr,
          options.redact,
        ));
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > OUTPUT_LIMIT) {
        child.kill();
        finish(capturedProcessError(
          `${path.basename(executable)} exceeded its stderr limit.`,
          stdout,
          stderr,
          options.redact,
        ));
      }
    });
    child.once('error', error => finish(capturedProcessError(
      `${path.basename(executable)} could not start: ${error.message}`,
      stdout,
      stderr,
      options.redact,
      error,
    )));
    child.once('close', (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }
      const detail = stderr.trim() || (signal ? `signal ${signal}` : `exit ${code}`);
      finish(capturedProcessError(
        `${path.basename(executable)} ${args.slice(0, 3).join(' ')} failed: ${detail}`,
        stdout,
        stderr,
        options.redact,
      ));
    });
  });
}

/** Let one caller stop waiting without cancelling work shared by other callers. */
export function waitForPromise<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** Start a child with the context defaults and caller overrides. */
export function spawnCommand(
  executable: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  options: SpawnOptions = {},
): ChildProcess {
  return spawn(executable, args, {
    ...options,
    cwd: options.cwd ?? cwd,
    env: mergeEnvironment(env, options.env),
    stdio: options.stdio ?? 'inherit',
    windowsHide: options.windowsHide ?? true,
  });
}

/** Separate an optional final SpawnOptions object from string arguments. */
export function splitSpawnArguments(values: readonly SpawnArgument[]): {
  args: string[];
  options: SpawnOptions;
} {
  const args = [...values];
  const last = args.at(-1);
  const options = typeof last === 'string' || last === undefined
    ? {}
    : args.pop() as SpawnOptions;
  return { args: args as string[], options };
}

/** Merge environment overrides without case-variant duplicates on Windows. */
export function mergeEnvironment(
  base: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (process.platform === 'win32') {
      const existing = Object.keys(environment).find(candidate =>
        candidate.toLowerCase() === key.toLowerCase()
      );
      if (existing && existing !== key) delete environment[existing];
    }
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }
  return environment;
}

/** Read environment keys case-insensitively on Windows. */
export function environmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  if (env[name] !== undefined || process.platform !== 'win32') return env[name];
  const key = Object.keys(env).find(candidate => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

function capturedProcessError(
  message: string,
  stdout: string,
  stderr: string,
  redact: readonly string[] | undefined,
  cause?: Error,
): CapturedProcessError {
  const safeStdout = redactValues(stdout, redact);
  const safeStderr = redactValues(stderr, redact);
  return new CapturedProcessError(
    redactValues(message, redact),
    { stderr: safeStderr, stdout: safeStdout },
    cause ? { cause } : undefined,
  );
}

function redactValues(value: string, redact: readonly string[] | undefined): string {
  let safe = value;
  for (const secret of redact ?? []) {
    if (secret) safe = safe.replaceAll(secret, '<python>');
  }
  return safe;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}
