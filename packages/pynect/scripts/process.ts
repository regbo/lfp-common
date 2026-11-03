export interface RunOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly inherit?: boolean;
}

/** Runs one command without a shell so arguments cannot be reinterpreted. */
export async function runCommand(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<string> {
  const child = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stderr: options.inherit ? 'inherit' : 'pipe',
    stdout: options.inherit ? 'inherit' : 'pipe',
  });

  if (options.inherit) {
    const exitCode = await child.exited;
    if (exitCode !== 0) {
      throw new Error(`${command} ${args.join(' ')} exited with ${exitCode}`);
    }
    return '';
  }

  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim();
    throw new Error(
      `${command} ${args.join(' ')} exited with ${exitCode}${detail ? `: ${detail}` : ''}`,
    );
  }
  return stdout.trim();
}
