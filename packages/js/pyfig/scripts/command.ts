import { spawnSync } from 'node:child_process';
import path from 'node:path';

export interface CommandOptions {
  capture?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** Run an argument-array command without shell parsing and fail with its useful output. */
export function runCommand(
  executable: string,
  args: string[],
  options: CommandOptions = {},
): string {
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env ?? process.env,
    maxBuffer: 16 * 1024 * 1024,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    windowsHide: true,
  });
  if (result.status !== 0 || result.error) {
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    const detail = stderr || result.error?.message || `exit ${result.status ?? 'unknown'}`;
    throw new Error(`${path.basename(executable)} ${args.slice(0, 4).join(' ')} failed: ${detail}`);
  }
  return typeof result.stdout === 'string' ? result.stdout.trim() : '';
}

/** Relaunch the current Bun executable instead of assuming `bun` is on PATH. */
export function runBun(args: string[], options: CommandOptions = {}): string {
  return runCommand(process.execPath, args, options);
}
