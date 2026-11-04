import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import path from 'node:path';

describe('model catalog example CLI', () => {
  test('list-models emits one JSON array without a null result', async () => {
    const result = await runExampleCli(['list-models', '--json']);
    const models = JSON.parse(result.stdout) as Model[];

    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('IPC server listening at');
    expectValidModels(models);
    expect(result.stdout.trimEnd().endsWith('null')).toBe(false);
  }, 60_000);

  test('list-models-stream emits each delayed model as one JSON line', async () => {
    const result = await runExampleCli(['list-models-stream', '--json']);
    const models = result.stdout.trim().split(/\r?\n/u)
      .map(line => JSON.parse(line) as Model);

    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('IPC server listening at');
    expectValidModels(models);
    expect(result.msAfterFirstOutput).toBeGreaterThan(2_000);
    expect(result.stdout.trimEnd().endsWith('null')).toBe(false);
  }, 60_000);

  test('list-models-stream completes without an element payload when no models match', async () => {
    const result = await runExampleCli([
      'list-models-stream',
      '--query',
      'this-model-does-not-exist',
      '--json',
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('IPC server listening at');
    expect(result.stdout).toBe('');
  }, 60_000);
});

interface Model {
  context_window: number;
  id: string;
  provider: 'anthropic' | 'openai';
}

function expectValidModels(models: Model[]): void {
  expect(models).toHaveLength(8);
  expect(models.every(model => model.id.startsWith(`${model.provider}-`))).toBe(true);
}

function runExampleCli(args: readonly string[]): Promise<{
  code: number | null;
  msAfterFirstOutput: number;
  stderr: string;
  stdout: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.resolve(import.meta.dir, '..', 'example', 'cli.ts'), ...args],
      {
        cwd: path.resolve(import.meta.dir, '..'),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    let stdout = '';
    let stderr = '';
    let firstOutputAt: number | undefined;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      firstOutputAt ??= Date.now();
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({
      code,
      msAfterFirstOutput: firstOutputAt === undefined ? 0 : Date.now() - firstOutputAt,
      stderr,
      stdout,
    }));
  });
}
