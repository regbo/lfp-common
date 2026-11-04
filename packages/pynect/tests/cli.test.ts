import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PACKAGE_VERSION } from '../src/js/_generated/metadata.ts';

describe('CLI', () => {
  let projectRoot = '';

  beforeAll(async () => {
    projectRoot = await mkdtemp(path.join(tmpdir(), 'pynect-cli-'));
  });

  afterAll(async () => {
    await rm(projectRoot, { force: true, recursive: true });
  });

  test('reports the package version', async () => {
    const result = await runCli(['--version']);

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(PACKAGE_VERSION);
  });

  test('builds nested help and options from the codegen schemas', async () => {
    const result = await runCli(['codegen', 'generate', '--help']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Generate TypeScript bindings from Python modules.');
    expect(result.stdout).toContain('-m, --module <value...>');
    expect(result.stdout).toContain('PYNECT_MODULE');
    expect(result.stdout).toContain('--no-auto-close');
    expect(result.stdout).toContain('--no-project');
    expect(result.stdout).toContain('--no-validate-pydantic');
    expect(result.stdout).not.toContain('commander');
  }, 30_000);

  test('finds its package root implicitly and reads nested command environment values', async () => {
    const result = await runCli(['codegen', 'setup-dev'], {
      PYNECT_DRY_RUN: 'true',
      PYNECT_ROOT: projectRoot,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Would update .vscode');
  }, 30_000);
});

function runCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const cli = path.join(import.meta.dir, '..', 'src', 'js', 'cli.mts');
    const child = spawn(process.execPath, [cli, ...args], {
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
