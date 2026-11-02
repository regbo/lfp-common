import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import path from 'node:path';

describe('CLI', () => {
  test('derives help and defaults from the Pyfig schemas', async () => {
    const result = await runCli(['resolve', '--help']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Resolve or provision compatible uv and Python executables.');
    expect(result.stdout).toContain('--uv <value>');
    expect(result.stdout).toContain('uv executable or PEP 440 constraint.');
    expect(result.stdout).toContain('(default: ">=0.10,<1")');
    expect(result.stdout).toContain('--require-embedding');
    expect(result.stdout).toContain('--require-gil');
    expect(result.stdout).toContain('--cwd <value>');
  }, 30_000);

  test('runs Python with forwarded arguments', async () => {
    const result = await runCli(['python', '--python', '<3.11', '--', '--version']);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^Python 3\.10\./u);
  }, 60_000);

  test('runs uv with forwarded arguments', async () => {
    const result = await runCli(['uv', '--version']);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^uv \d+\.\d+/u);
  }, 60_000);

  test('writes diagnostics to stderr with --debug', async () => {
    const result = await runCli(['resolve', '--debug']);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('[pyfig:debug] Ensuring CLI dependencies are installed.');
    expect(result.stderr).toContain('[pyfig:debug] Resolving runtime context.');
    expect(result.stderr).toContain('[pyfig:debug] Resolved Python.');
  }, 60_000);
});

function runCli(args: readonly string[]): Promise<{
  code: number | null;
  stderr: string;
  stdout: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(import.meta.dir, '..', 'src', 'cli.ts'), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stderr, stdout }));
  });
}