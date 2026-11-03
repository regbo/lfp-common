import { describe, expect, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_UV,
  pyfig,
  pyfigOptionsSchema,
  PythonContext,
} from '../src/index.ts';
import {
  capture,
  CapturedProcessError,
  findExecutables,
} from '../src/process.ts';

describe('pyfig', () => {
  test('returns uv metadata and only a Python spawn helper', async () => {
    const context = await pyfig({
      uv: '>=0.10,<1',
      python: '>=3.10,<4',
    });

    expect(context).toBeInstanceOf(PythonContext);
    expect(Object.keys(context).sort()).toEqual(['python', 'uv']);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.keys(context.uv).sort()).toEqual(['path', 'source', 'version']);
    expect(Object.keys(context.python)).toEqual([]);
    expect(Object.isFrozen(context.uv)).toBe(true);
    expect(Object.isFrozen(context.python)).toBe(true);
    expect(path.isAbsolute(context.uv.path)).toBe(true);
    expect(context.uv.version).toMatch(/^\d+\.\d+/u);
    expect(['cache', 'download', 'path']).toContain(context.uv.source);
    expect('path' in context.python).toBe(false);
    expect('version' in context.python).toBe(false);
    expect('source' in context.python).toBe(false);
    expect(typeof context.uv.spawn).toBe('function');
    expect(typeof context.python.spawn).toBe('function');
  }, 60_000);

  test('executes Python through uv without exposing interpreter metadata', async () => {
    const context = await pyfig({ python: '>=3.10,<4' });
    const child = await context.python.spawn(
      '-c',
      'import os, sys; print(os.environ["UV_RUN_RECURSION_DEPTH"]); print(sys.argv[1])',
      'forwarded',
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const output = await collect(child);

    expect(output.code).toBe(0);
    expect(output.stdout.trim().split(/\r?\n/u)).toEqual(['1', 'forwarded']);
    expect(child.spawnargs).not.toContain('--python');
    expect('path' in context.python).toBe(false);
    expect('version' in context.python).toBe(false);
    expect('source' in context.python).toBe(false);
  }, 120_000);

  test('spawns uv with arguments and Node spawn options', async () => {
    const context = await pyfig();
    const child = await context.uv.spawn('--version', {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = await collect(child);

    expect(output.code).toBe(0);
    expect(output.stdout).toMatch(/^uv \d+\.\d+/u);
  }, 60_000);

  test('shares successful Python resolution across concurrent spawns', async () => {
    const context = await pyfig({ python: '>=3.10,<4' });
    const [first, second] = await Promise.all([
      context.python.spawn('-c', 'print("first")', { stdio: ['ignore', 'pipe', 'pipe'] }),
      context.python.spawn('-c', 'print("second")', { stdio: ['ignore', 'pipe', 'pipe'] }),
    ]);
    const [firstOutput, secondOutput] = await Promise.all([collect(first), collect(second)]);

    expect(firstOutput.stdout.trim()).toBe('first');
    expect(secondOutput.stdout.trim()).toBe('second');
  }, 120_000);

  test('defers invalid Python requests until Python is spawned', async () => {
    const context = await pyfig({ python: 'definitely-not-a-python-request' });

    let firstError: unknown;
    let secondError: unknown;
    try {
      await context.python.spawn('--version', { stdio: 'ignore' });
    } catch (error) {
      firstError = error;
    }
    try {
      await context.python.spawn('--version', { stdio: 'ignore' });
    } catch (error) {
      secondError = error;
    }
    expect(firstError).toBeInstanceOf(Error);
    expect(secondError).toBeInstanceOf(Error);
    expect(secondError).not.toBe(firstError);
  }, 120_000);

  test('rejects an already-aborted Python spawn before starting resolution', async () => {
    const context = await pyfig({ python: '>=3.10,<4' });
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    await expect(context.python.spawn('--version', {
      signal: controller.signal,
      stdio: 'ignore',
    })).rejects.toThrow('cancelled');
  }, 60_000);

  test('rejects malformed uv selections', async () => {
    await expect(pyfig({
      uv: path.join(process.cwd(), 'missing-uv'),
    })).rejects.toThrow('executable or be a valid PEP 440');
    await expect(pyfig({
      uv: 'not a constraint',
    })).rejects.toThrow('executable or be a valid PEP 440');
  });

  test('does not use public metadata with only a custom installer source', async () => {
    const cache = await mkdtemp(path.join(os.tmpdir(), 'pyfig-custom-source-'));
    try {
      await expect(pyfig({
        uv: '>=99,<100',
        env: {
          PATH: '',
          PYFIG_CACHE_DIR: cache,
          UV_INSTALLER_GITHUB_BASE_URL: 'https://packages.example.test',
        },
      })).rejects.toThrow('also requires UV_ASTRAL_MIRROR_URL');
    } finally {
      await rm(cache, { force: true, recursive: true });
    }
  });

  test('publishes described defaults through the options schema', () => {
    const parsed = pyfigOptionsSchema.parse({});

    expect(parsed).toEqual({
      uv: DEFAULT_UV,
      debug: false,
      cwd: process.cwd(),
    });
    const shape = pyfigOptionsSchema.unwrap().shape;
    expect(shape.uv.description).toContain('PEP 440');
    expect(shape.python.description).toContain('first spawned');
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(pyfigOptionsSchema.parse({ env: '{"PYFIG_TEST":"yes"}' }).env).toEqual({
      PYFIG_TEST: 'yes',
    });
  });

  test('keeps the runtime API minimal', async () => {
    const api = await import('../src/index.ts');
    expect(Object.keys(api).sort()).toEqual([
      'DEFAULT_UV',
      'PythonContext',
      'pyfig',
      'pyfigOptionsSchema',
    ]);
  });
});

describe('executable discovery', () => {
  test('yields PATH candidates in order and can stop after the first result', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pyfig-path-'));
    const firstDirectory = path.join(root, 'first');
    const secondDirectory = path.join(root, 'second');
    const executableName = process.platform === 'win32' ? 'uv.EXE' : 'uv';
    try {
      await mkdir(firstDirectory);
      await mkdir(secondDirectory);
      const first = path.join(firstDirectory, executableName);
      const second = path.join(secondDirectory, executableName);
      await writeFile(first, 'first');
      await writeFile(second, 'second');

      const candidates = findExecutables(['uv'], root, {
        PATH: [firstDirectory, secondDirectory].join(path.delimiter),
        PATHEXT: '.EXE',
      });
      const result = await candidates.next();
      await candidates.return();

      expect(result.done).toBe(false);
      expect(pathsEqual(result.value ?? '', first)).toBe(true);

      const relativeCandidate = findExecutables(['uv'], root, {
        PATH: 'first',
        PATHEXT: '.EXE',
      });
      const relativeResult = await relativeCandidate.next();
      await relativeCandidate.return();
      expect(pathsEqual(relativeResult.value ?? '', first)).toBe(true);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe('subprocess errors', () => {
  test('redacts private interpreter values', async () => {
    const privatePath = path.join(os.tmpdir(), 'private-python', 'python.exe');
    let failure: unknown;
    try {
      await capture(
        process.execPath,
        ['-e', `console.error(${JSON.stringify(privatePath)}); process.exit(2)`],
        process.cwd(),
        process.env,
        { redact: [privatePath] },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(CapturedProcessError);
    expect((failure as Error).message).not.toContain(privatePath);
    expect((failure as CapturedProcessError).stderr).not.toContain(privatePath);
    expect((failure as Error).message).toContain('<python>');
  });
});

function pathsEqual(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function collect(child: ChildProcess): Promise<{
  code: number | null;
  stderr: string;
  stdout: string;
}> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stderr, stdout }));
  });
}
