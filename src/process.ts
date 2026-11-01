import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import which from 'which';

export interface CommandSpec {
  executable: string;
  args: string[];
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

export async function resolveExecutable(
  value: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  if (!value) return null;
  if (path.isAbsolute(value)) {
    return await which(value, { nothrow: true, path: env['PATH'], pathExt: env['PATHEXT'] });
  }
  if (!/^[A-Za-z0-9_.-]+$/u.test(value)) return null;
  return await which(value, { nothrow: true, path: env['PATH'], pathExt: env['PATHEXT'] });
}

export function run(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): RunResult {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    env,
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0 || result.error) {
    const detail = result.stderr?.trim() || result.error?.message || `exit ${result.status}`;
    throw new Error(`${path.basename(executable)} ${args.slice(0, 3).join(' ')} failed: ${detail}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

/** Run a child without blocking lock heartbeats or other coordination timers. */
export async function runAsync(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal?: AbortSignal,
  cwd?: string,
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(executable, args, {
      env,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error?: Error, result?: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else if (result) resolve(result);
    };
    const abort = (): void => {
      child.kill();
      const reason = signal?.reason;
      finish(reason instanceof Error ? reason : new Error(`${path.basename(executable)} was aborted.`));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`${path.basename(executable)} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 4 * 1024 * 1024) {
        child.kill();
        finish(new Error(`${path.basename(executable)} exceeded the output limit.`));
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 4 * 1024 * 1024) {
        child.kill();
        finish(new Error(`${path.basename(executable)} exceeded the error-output limit.`));
      }
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code, childSignal) => {
      if (code !== 0) {
        const detail = stderr.trim() || (childSignal ? `signal ${childSignal}` : `exit ${code}`);
        finish(new Error(`${path.basename(executable)} ${args.slice(0, 3).join(' ')} failed: ${detail}`));
        return;
      }
      finish(undefined, { stdout, stderr });
    });

    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}
