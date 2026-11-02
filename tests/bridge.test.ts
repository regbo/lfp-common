import { describe, expect, test } from 'bun:test';
import { createVenv, kwargs, type PythonObject } from '../src';

describe('Python Venv bridge', () => {
  test('bridges calls, objects, callbacks, kwargs, async functions, and iteration', async () => {
    const venv = createVenv({ autoClose: false, project: false });
    try {
      const fixture = await venv.import('tests.fixtures.bridge_fixture');

      expect(await fixture.add(2, 3)).toBe(5);
      expect(await fixture.describe('pynect', kwargs({ suffix: '!' }))).toBe('pynect!');
      expect(await fixture.async_add(4, 5)).toBe(9);

      const counter = await fixture.Counter(10) as PythonObject;
      expect(await counter.value).toBe(10);
      expect(await counter.increment(2)).toBe(12);
      expect(await counter.$value()).toEqual({ value: 12 });

      const callbackResult = await fixture.call_callback(
        async (value: unknown) => fixture.add(value, 1),
        6,
      );
      expect(callbackResult).toBe(7);

      const values: unknown[] = [];
      const iterator = await fixture.count(3) as PythonObject;
      for await (const value of iterator) values.push(value);
      expect(values).toEqual([0, 1, 2]);
    } finally {
      await venv.close();
    }
  }, 120_000);
});
