import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type {
  WeatherChange,
  WeatherSnapshot,
} from '../../../py/pynect-example/_generated/pynect-example/index.js';

describe('Pynect example CLI', () => {
  test('requests weather through owned stdio even when a remote endpoint is configured', async () => {
    const result = await runExampleCli(['weather', '--location', 'Boston, MA', '--json']);
    const weather = JSON.parse(result.stdout) as WeatherSnapshot;

    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('@pynect:');
    expect(weather.location).toBe('Boston, MA');
    expect(weather.temperature_c).toBeNumber();
    expect(result.stdout.trimEnd().endsWith('null')).toBe(false);
  }, 60_000);

  test('emits each generated weather change as one JSON line', async () => {
    const result = await runExampleCli([
      'watch-weather',
      '--location', 'Seattle, WA',
      '--updates', '3',
      '--interval', '0.075',
      '--json',
    ]);
    const changes = result.stdout.trim().split(/\r?\n/u)
      .map(line => JSON.parse(line) as WeatherChange);

    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('@pynect:');
    expect(changes).toHaveLength(3);
    expect(changes.map(change => change.sequence)).toEqual([1, 2, 3]);
    expect(changes.every(change => change.weather.location === 'Seattle, WA')).toBe(true);
    expect(result.msAfterFirstOutput).toBeGreaterThanOrEqual(100);
    expect(result.stdout.trimEnd().endsWith('null')).toBe(false);
  }, 60_000);

  test('documents the local-model chat command without starting Python', async () => {
    const result = await runExampleCli(['chat', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('local SmolLM2 model');
    expect(result.stdout).toContain('--message');
  }, 60_000);

  test('requires a single message when chat output is JSON', async () => {
    const result = await runExampleCli(['chat', '--json']);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('--json requires --message');
  }, 60_000);
});

function runExampleCli(args: readonly string[]): Promise<{
  code: number | null;
  msAfterFirstOutput: number;
  stderr: string;
  stdout: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.resolve(
          import.meta.dir,
          '..', '..', '..', 'py', 'pynect-example', 'cli.ts',
        ),
        ...args,
      ],
      {
        cwd: path.resolve(import.meta.dir, '..'),
        env: {
          ...process.env,
          // A remote client would fail immediately; the CLI must ignore this.
          CHANX_BASE_URL: 'ws://127.0.0.1:1',
        },
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
