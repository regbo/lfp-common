import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import path from 'node:path';

describe('CLI', () => {
  test('derives help and defaults from the Pyfig schemas', async () => {
    const result = await runCli(['resolve', '--help']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Resolve uv and the requested Python through uv.');
    expect(result.stdout).toContain('-u, --uv <value>');
    expect(result.stdout).toContain('uv executable or PEP 440 constraint.');
    expect(result.stdout).toContain('(default: ">=0.10,<1", env: PYFIG_UV)');
    expect(result.stdout).toContain('--python <value>');
    expect(result.stdout).toContain('Python request passed unchanged to uv when Python is');
    expect(result.stdout).toContain('first resolved.');
    expect(result.stdout).not.toContain('--require-embedding');
    expect(result.stdout).not.toContain('--require-gil');
    expect(result.stdout).toContain('--cwd <value>');
  }, 30_000);

  test('resolves uv and Python metadata before rendering', async () => {
    const result = await runCli(['resolve', '--python', '>=3.10,<4']);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^uv \d+\.\d+/mu);
    expect(result.stdout).toMatch(/^Python \d+\.\d+\.\d+: .+/mu);
  }, 60_000);

  test('reports resolved Python state in structured output', async () => {
    const result = await runCli(['resolve', '--json', '--python', '>=3.10,<4']);
    const output = JSON.parse(result.stdout) as {
      python: { path: string; resolved: boolean; version: string };
    };

    expect(result.code).toBe(0);
    expect(path.isAbsolute(output.python.path)).toBe(true);
    expect(output.python.resolved).toBe(true);
    expect(output.python.version).toMatch(/^\d+\.\d+\.\d+/u);
  }, 60_000);

  test('reads Pyfig options from environment variables', async () => {
    const result = await runCli(['resolve', '--json'], {
      PYFIG_DEBUG: 'true',
      PYFIG_PYTHON: '>=3.10,<4',
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('[pyfig:debug] Resolving runtime context.');
    expect(JSON.parse(result.stdout)).toHaveProperty('python.resolved', true);
  }, 60_000);

  test('gives CLI options precedence over environment variables', async () => {
    const result = await runCli(['resolve', '--uv', '>=0.10,<1'], {
      PYFIG_UV: 'not a valid uv request',
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^uv \d+\.\d+/mu);
  }, 60_000);

  test('runs Python with Pyfig options before passthrough arguments', async () => {
    const result = await runCli([
      'python',
      '--python',
      '>=3.10,<4',
      '--',
      '-c',
      'import sys; print(sys.version_info.major, sys.version_info.minor)',
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^3 \d+$/mu);
  }, 60_000);

  test('runs uv with passthrough arguments', async () => {
    const result = await runCli(['uv', '--', '--version']);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^uv \d+\.\d+/mu);
  }, 60_000);

  test('still accepts direct executable options without a separator', async () => {
    const result = await runCli(['uv', '--version']);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^uv \d+\.\d+/mu);
  }, 60_000);

  test('writes diagnostics to stderr with --debug', async () => {
    const result = await runCli(['resolve', '--debug']);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('[pyfig:debug] Resolving runtime context.');
    expect(result.stderr).toContain('[pyfig:debug] Resolved Python through uv.');
  }, 60_000);
});

function runCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{
  code: number | null;
  stderr: string;
  stdout: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(import.meta.dir, '..', 'src', 'cli.ts'), ...args], {
      env: { ...process.env, ...env },
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
