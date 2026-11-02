import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import which from 'which';

const OUTPUT_LIMIT = 1024 * 1024;

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

/** Enumerate matching executable files in PATH order without invoking them. */
export async function findExecutables(
  names: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const directories = (environmentValue(env, 'PATH') ?? '')
    .split(path.delimiter)
    .filter(Boolean);
  const extensions = process.platform === 'win32'
    ? (environmentValue(env, 'PATHEXT') ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const directory of directories) {
    for (const name of names) {
      const hasExtension = path.extname(name).length > 0;
      for (const extension of hasExtension ? [''] : extensions) {
        const candidate = path.resolve(directory, `${name}${extension}`);
        const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          await access(candidate);
          candidates.push(candidate);
        } catch {
          // Missing and inaccessible PATH entries are not executable candidates.
        }
      }
    }
  }
  return candidates;
}

/** Capture a bounded child-process response or throw with its stderr. */
export async function capture(
  executable: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
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
        finish(new Error(`${path.basename(executable)} exceeded its stdout limit.`));
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > OUTPUT_LIMIT) {
        child.kill();
        finish(new Error(`${path.basename(executable)} exceeded its stderr limit.`));
      }
    });
    child.once('error', error => finish(error));
    child.once('close', (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }
      const detail = stderr.trim() || (signal ? `signal ${signal}` : `exit ${code}`);
      finish(new Error(`${path.basename(executable)} ${args.slice(0, 3).join(' ')} failed: ${detail}`));
    });
  });
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
