import { describe, expect, test } from 'bun:test';
import { createVenv, createVenvOptionsSchema, PythonVenv, kwargs } from '../src/js';
import { serverOptionsSchema } from '../src/js/schema';

describe('public API', () => {
  test('validates Venv options through the public schema', () => {
    expect(createVenvOptionsSchema.parse({ callTimeoutMs: 0 }).callTimeoutMs).toBe(0);
    expect(() => createVenvOptionsSchema.parse({ startupTimeoutMs: 0 })).toThrow();
  });

  test('publishes the Pydantic-derived server schema', () => {
    expect(serverOptionsSchema.parse({})).toEqual({
      host: '127.0.0.1',
      maxFrameBytes: 8 * 1024 * 1024,
      modules: {},
      path: '/pynect',
      port: 0,
      validatePydantic: true,
    });
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
    const pynect = await import('../src/js');
    for (const name of ['createPythonBridge', 'init', 'shutdown', 'getRuntime']) {
      expect(name in pynect).toBe(false);
    }
  });
});
