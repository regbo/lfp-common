import { basename } from "node:path";

export interface RunOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly inherit?: boolean;
}
/** Run an argument-array command without shell interpolation. */
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
    windowsHide: true,
  });

  if (options.inherit) {
    const exitCode = await child.exited;
    if (exitCode !== 0) {
      throw new Error(`${command} ${args.slice(0, 4).join(' ')} exited with ${exitCode}.`);
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
      `${command} ${args.slice(0, 4).join(' ')} exited with ${exitCode}` +
      (detail ? `: ${detail}` : '.'),
    );
  }
  return stdout.trim();
}


/** Relaunch the current Bun executable without assuming a PATH entry. */
export async function runBun(args: readonly string[], options: RunOptions = {}): Promise<string> {
  let executable: string | null = null;

  const execPath = process.execPath;
  if (execPath) {
    const filename = basename(execPath); // e.g. "bun" or "bun.exe"

    if (filename.toLowerCase() === "bun" || filename.toLowerCase() === "bun.exe") {
      executable = execPath;
    }
  }

  if (!executable) {
    try {
      const bunModule = await import("bun");
      const whichFn = bunModule.which ?? (typeof Bun !== "undefined" ? Bun.which : null);
      if (typeof whichFn === "function") {
        executable = whichFn("bun");
      }
    } catch {
      // Ignore resolution errors
    }
  }

  return runCommand(executable || "bun", args, options);
}