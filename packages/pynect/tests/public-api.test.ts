import { describe, expect, test } from 'bun:test';
import { createVenv, createVenvOptionsSchema, PythonVenv, kwargs } from '../src';

describe('public API', () => {
  test('validates Venv options through the public schema', () => {
    expect(createVenvOptionsSchema.parse({ callTimeoutMs: 0 }).callTimeoutMs).toBe(0);
    expect(() => createVenvOptionsSchema.parse({ startupTimeoutMs: 0 })).toThrow();
  });

  test('creates a lazy Venv without starting Python', async () => {
    const venv = createVenv({ project: false });

    expect(venv).toBeInstanceOf(PythonVenv);
    expect(venv.started).toBe(false);
    expect(kwargs({ limit: 2 }).value).toEqual({ limit: 2 });

    await venv.close();
    expect(venv.closed).toBe(true);
    expect(venv.started).toBe(false);
  });

  test('does not retain legacy embedded-runtime exports', async () => {
    const pynect = await import('../src');
    for (const name of ['createPythonBridge', 'init', 'shutdown', 'getRuntime']) {
      expect(name in pynect).toBe(false);
    }
  });
});
