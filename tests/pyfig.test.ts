import { describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pyfig, PythonContext } from '../src/index.ts';
import { buildRunArgs } from '../src/pyfig.ts';

describe('pyfig', () => {
  test('returns compatible uv and Python paths with one run method', async () => {
    const resolved = await pyfig({
      uv: '>=0.10,<1',
      python: '>=3.10,<4',
    });

    expect(resolved).toBeInstanceOf(PythonContext);
    expect(Object.keys(resolved).sort()).toEqual(['python', 'uv']);
    expect(path.isAbsolute(resolved.uv)).toBe(true);
    expect(path.isAbsolute(resolved.python)).toBe(true);
    expect(typeof resolved.run).toBe('function');
  }, 60_000);

  test('prefers a compatible system Python over uv managed installations', async () => {
    const specifier = '>=3.10,<4';
    const resolved = await pyfig({ python: specifier });
    const expected = await capture(spawn(resolved.uv, [
      'python',
      'find',
      '--system',
      '--no-managed-python',
      specifier,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }));

    expect(pathsEqual(resolved.python, expected.trim())).toBe(true);
  }, 60_000);

  test('pins Python and creates a command separator when one is omitted', () => {
    expect(buildRunArgs('/python', ['python', '--version'])).toEqual([
      'run',
      '--python',
      '/python',
      '--',
      'python',
      '--version',
    ]);
  });

  test('preserves uv arguments and rejects Python before the separator', () => {
    expect(buildRunArgs('/python', ['--no-project', '--', 'python', '--version'])).toEqual([
      'run',
      '--no-project',
      '--python',
      '/python',
      '--',
      'python',
      '--version',
    ]);
    expect(() => buildRunArgs('/python', [
      '--python',
      '/python',
      '--',
      'python',
    ])).toThrow('does not accept --python');
    expect(() => buildRunArgs('/python', [
      '--python=/python',
      '--',
      'python',
    ])).toThrow('does not accept --python');
    expect(buildRunArgs('/python', [
      '--',
      'tool',
      '--python',
      '/command-argument',
    ])).toEqual([
      'run',
      '--python',
      '/python',
      '--',
      'tool',
      '--python',
      '/command-argument',
    ]);
  });

  test('runs commands asynchronously with final SpawnOptions', async () => {
    const uv = await pyfig({ python: '>=3.10,<4' });
    const child = uv.run(
      'python',
      '-I',
      '-S',
      '-c',
      'import sys; print(sys.executable)',
      {
        cwd: os.tmpdir(),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const output = await capture(child);
    expect(pathsEqual(output.trim(), uv.python)).toBe(true);
  }, 60_000);

  test('gives executable paths precedence over version selection', async () => {
    const selected = await pyfig({
      uv: '>=0.10,<1',
      python: '>=3.10,<4',
    });
    const explicit = await pyfig({
      // Any executable is trusted here, which proves explicit uv paths skip
      // version probing and setup. run() remains the caller's responsibility.
      uv: process.execPath,
      python: selected.python,
    });
    expect(pathsEqual(explicit.uv, process.execPath)).toBe(true);
    expect(pathsEqual(explicit.python, selected.python)).toBe(true);
  }, 60_000);

  test('still checks requested capabilities for an explicit Python executable', async () => {
    const selected = await pyfig({
      python: '>=3.10,<4',
      requireEmbedding: true,
      requireGil: true,
    });
    const explicit = await pyfig({
      uv: selected.uv,
      python: selected.python,
      requireEmbedding: true,
      requireGil: true,
    });

    expect(pathsEqual(explicit.python, selected.python)).toBe(true);
  }, 120_000);

  test('rejects malformed selections and non-Python executables', async () => {
    await expect(pyfig({
      uv: path.join(process.cwd(), 'missing-uv'),
    })).rejects.toThrow('executable or be a valid PEP 440');
    await expect(pyfig({
      uv: 'not a constraint',
    })).rejects.toThrow('executable or be a valid PEP 440');
    await expect(pyfig({
      python: process.execPath,
    })).rejects.toThrow();
  });

  test('keeps the runtime API minimal', async () => {
    const api = await import('../src/index.ts');
    expect(Object.keys(api).sort()).toEqual(['PythonContext', 'pyfig']);
  });
});

function capture(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `uv exited ${code}`));
    });
  });
}

function pathsEqual(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
