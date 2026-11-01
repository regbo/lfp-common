import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import * as workerThreads from 'node:worker_threads';
import lockfile from 'proper-lockfile';
import { resolveExecutable } from './process.js';

interface LockManagerLike {
  request<T>(
    name: string,
    options: { mode: 'exclusive'; signal: AbortSignal },
    callback: () => Promise<T>,
  ): Promise<T>;
}

export interface ResourceLockOptions {
  /** Stable logical identity shared by every caller of the protected resource. */
  key: string;
  /** Existing directory used by the portable cross-process lease. */
  target: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
}

export interface ProvisioningLockOptions<T> extends ResourceLockOptions {
  check: () => Promise<T | null>;
  mutate: (signal: AbortSignal) => Promise<T>;
}

const realmMutexTails = new Map<string, Promise<void>>();
const flockLookups = new Map<string, Promise<string | null>>();
const FLOCK_READY = 'PYFIG_FLOCK_READY';
const FLOCK_HOLDER = [
  `process.stdout.write('${FLOCK_READY}\\n')`,
  'process.stdin.resume()',
  'process.stdin.once("end",()=>process.exit(0))',
].join(';');

/**
 * Apply check-lock-check around an idempotent provisioning mutation. The lock
 * stack is ordered identically everywhere to prevent lock-order inversions.
 */
export async function withProvisioningLock<T>(
  options: ProvisioningLockOptions<T>,
): Promise<T> {
  const existing = await options.check();
  if (existing !== null) return existing;

  return withResourceLock(options, async (signal) => {
    const rechecked = await options.check();
    return rechecked ?? options.mutate(signal);
  });
}

/**
 * Serialize a resource in the current realm, across supported Node workers,
 * through native flock when present, and finally through a portable file lease.
 */
export async function withResourceLock<T>(
  options: ResourceLockOptions,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  await mkdir(options.target, { recursive: true });
  return withRealmMutex(options.key, () =>
    withWorkerLock(options, () =>
      withNativeFlock(options, () =>
        withPortableLease(options, operation))));
}

async function withRealmMutex<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = realmMutexTails.get(key) ?? Promise.resolve();
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  realmMutexTails.set(key, tail);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    releaseGate();
    if (realmMutexTails.get(key) === tail) realmMutexTails.delete(key);
  }
}

async function withWorkerLock<T>(
  options: ResourceLockOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const manager = (workerThreads as unknown as { locks?: LockManagerLike }).locks;
  if (!manager?.request) return operation();

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error(`Timed out waiting for worker lock ${options.key}.`)),
    options.timeoutMs,
  );
  let entered = false;
  try {
    return await manager.request(
      workerLockName(options.key),
      { mode: 'exclusive', signal: controller.signal },
      async () => {
        entered = true;
        return operation();
      },
    );
  } catch (error) {
    // Worker locks are an optimization on runtimes that expose the experimental
    // API. The portable lease remains authoritative when acquisition is absent.
    if (entered) throw error;
    return operation();
  } finally {
    clearTimeout(timeout);
  }
}

async function withNativeFlock<T>(
  options: ResourceLockOptions,
  operation: () => Promise<T>,
): Promise<T> {
  if (process.platform === 'win32') return operation();
  // Coordination helpers belong to the host runtime, not the child discovery
  // environment, which callers may intentionally strip of Python and uv paths.
  const executable = await findFlock(process.env);
  if (!executable) return operation();

  const child = await acquireFlock(executable, `${options.target}.flock`, options.timeoutMs);
  if (!child) return operation();
  try {
    return await operation();
  } finally {
    await releaseFlock(child);
  }
}

async function findFlock(env: NodeJS.ProcessEnv): Promise<string | null> {
  const lookupKey = `${env['PATH'] ?? ''}\0${env['PATHEXT'] ?? ''}`;
  let lookup = flockLookups.get(lookupKey);
  if (!lookup) {
    lookup = resolveExecutable('flock', env);
    flockLookups.set(lookupKey, lookup);
  }
  return lookup;
}

async function acquireFlock(
  executable: string,
  lockPath: string,
  timeoutMs: number,
): Promise<ChildProcessWithoutNullStreams | null> {
  const waitSeconds = Math.max(1, Math.ceil(Math.min(timeoutMs, 30_000) / 1000));
  const child = spawn(
    executable,
    ['-x', '-w', String(waitSeconds), lockPath, process.execPath, '-e', FLOCK_HOLDER],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );
  child.stderr.resume();
  let output = '';
  const acquired = await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), Math.min(timeoutMs, 30_000) + 5_000);
    child.once('error', () => finish(false));
    child.once('exit', () => finish(false));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.includes(FLOCK_READY)) finish(true);
    });
  });
  if (acquired) return child;
  child.kill();
  return null;
}

async function releaseFlock(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  child.stdin.end();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve();
    }, 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function withPortableLease<T>(
  options: ResourceLockOptions,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let compromised: Error | null = null;
  const retryIntervalMs = 500;
  const release = await lockfile.lock(options.target, {
    realpath: true,
    stale: 120_000,
    update: 15_000,
    retries: {
      retries: Math.ceil(options.timeoutMs / retryIntervalMs),
      factor: 1,
      minTimeout: retryIntervalMs,
      maxTimeout: retryIntervalMs,
    },
    onCompromised: (error) => {
      compromised = error;
      controller.abort(error);
    },
  });
  try {
    const result = await operation(controller.signal);
    if (compromised) throw compromised;
    return result;
  } finally {
    controller.abort();
    await release();
  }
}

function workerLockName(key: string): string {
  return `pyfig:${createHash('sha256').update(key).digest('hex')}`;
}

/** Create a canonical lock target below a configured cache directory. */
export function cacheLockTarget(cacheDirectory: string, name: string): string {
  return path.join(cacheDirectory, 'locks', name);
}
