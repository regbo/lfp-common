import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import {
  DEFAULT_UV,
  pyfig,
  pyfigOptionsSchema,
  PythonContext,
} from '../src/index.ts';

describe('pyfig', () => {
  test('returns only compatible uv and Python paths', async () => {
    const resolved = await pyfig({
      uv: '>=0.10,<1',
      python: '>=3.10,<4',
    });

    expect(resolved).toBeInstanceOf(PythonContext);
    expect(Object.keys(resolved).sort()).toEqual(['python', 'uv']);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.keys(resolved.uv).sort()).toEqual(['path', 'source', 'version']);
    expect(Object.keys(resolved.python).sort()).toEqual(['path', 'source', 'version']);
    expect(Object.isFrozen(resolved.uv)).toBe(true);
    expect(Object.isFrozen(resolved.python)).toBe(true);
    expect(path.isAbsolute(resolved.uv.path)).toBe(true);
    expect(path.isAbsolute(resolved.python.path)).toBe(true);
    expect(resolved.uv.version).toMatch(/^\d+\.\d+/u);
    expect(resolved.python.version).toMatch(/^\d+\.\d+/u);
    expect(['cache', 'download', 'path']).toContain(resolved.uv.source);
    expect(['managed', 'path', 'system']).toContain(resolved.python.source);
    expect('run' in resolved).toBe(false);
  }, 60_000);

  test('reports how an automatically selected Python was discovered', async () => {
    const specifier = '>=3.10,<4';
    const resolved = await pyfig({ python: specifier });

    expect(['managed', 'path', 'system']).toContain(resolved.python.source);
  }, 60_000);

  test('gives executable paths precedence over version selection', async () => {
    const selected = await pyfig({
      uv: '>=0.10,<1',
      python: '>=3.10,<4',
    });
    const explicit = await pyfig({
      uv: selected.uv.path,
      python: selected.python.path,
    });
    expect(pathsEqual(explicit.uv.path, selected.uv.path)).toBe(true);
    expect(explicit.uv.version).toBe(selected.uv.version);
    expect(explicit.uv.source).toBe('explicit');
    expect(pathsEqual(explicit.python.path, selected.python.path)).toBe(true);
    expect(explicit.python.version).toBe(selected.python.version);
    expect(explicit.python.source).toBe('explicit');
  }, 60_000);

  test('still checks requested capabilities for an explicit Python executable', async () => {
    const selected = await pyfig({
      python: '>=3.10,<4',
      requireEmbedding: true,
      requireGil: true,
    });
    const explicit = await pyfig({
      uv: selected.uv.path,
      python: selected.python.path,
      requireEmbedding: true,
      requireGil: true,
    });

    expect(pathsEqual(explicit.python.path, selected.python.path)).toBe(true);
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

  test('publishes described defaults through the options schema', () => {
    const parsed = pyfigOptionsSchema.parse({});

    expect(parsed).toEqual({
      uv: DEFAULT_UV,
      requireEmbedding: false,
      requireGil: false,
      debug: false,
      cwd: process.cwd(),
    });
    const shape = pyfigOptionsSchema.unwrap().shape;
    expect(shape.uv.description).toContain('PEP 440');
    expect(shape.python.description).toContain('Python executable');
    expect(shape.requireEmbedding.description).toContain('CPython headers');
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

function pathsEqual(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
