import { describe, expect, test } from 'bun:test';
import { createVenv, kwargs, type PythonObject } from '../src';

describe('Python Venv bridge', () => {
  test('bridges calls, objects, callbacks, kwargs, async functions, and iteration', async () => {
    const venv = createVenv({
      autoClose: false,
      modules: { fixture: 'tests.fixtures.bridge_fixture' },
      project: false,
    });
    try {
      const fixture = await venv.import('fixture');

      expect(await fixture.add(2, 3)).toBe(5);
      expect(await fixture.describe('pynect', kwargs({ suffix: '!' }))).toBe('pynect!');
      expect(await fixture.async_add(4, 5)).toBe(9);
      expect(await fixture.binary_payload()).toEqual(
        Uint8Array.from([0, 112, 121, 110, 101, 99, 116, 255]),
      );

      const counter = await fixture.Counter(10) as PythonObject;
      expect(await counter.value).toBe(10);
      expect(await counter.increment(2)).toBe(12);
      expect(await counter.$value()).toEqual({ value: 12 });
      await counter.$release();

      const callbackResult = await fixture.call_callback(
        async (value: unknown) => fixture.add(value, 1),
        6,
      );
      expect(callbackResult).toBe(7);

      const values: unknown[] = [];
      const iterator = await fixture.count(3) as PythonObject;
      for await (const value of iterator) values.push(value);
      expect(values).toEqual([0, 1, 2]);
      await iterator.$release();
    } finally {
      await venv.close();
    }
  }, 120_000);

  test('releases transient and Python-retained callback leases', async () => {
    const venv = createVenv({ autoClose: false, project: false });
    try {
      const fixture = await venv.import('tests.fixtures.bridge_fixture');

      const transient = await passTransientCallback(fixture);
      expect(await waitForCollection(transient)).toBe(true);

      const rejected = await rejectCallbackWithCircularArgument(fixture);
      expect(await waitForCollection(rejected)).toBe(true);

      const retained = await storeCallback(fixture);
      Bun.gc(true);
      expect(retained.deref()).toBeDefined();
      expect(await fixture.call_stored_callback(6)).toBe(7);
      await fixture.clear_stored_callback();
      expect(await waitForCollection(retained)).toBe(true);
    } finally {
      await venv.close();
    }
  }, 120_000);

  test('releases remote iterators as soon as iteration finishes', async () => {
    const venv = createVenv({ autoClose: false, project: false });
    try {
      const fixture = await venv.import('tests.fixtures.bridge_fixture');
      const iterable = await fixture.tracked_iterable(3) as PythonObject;
      const values: unknown[] = [];

      for await (const value of iterable) values.push(value);

      expect(values).toEqual([0, 1, 2]);
      expect(await fixture.released_iterator_count()).toBe(1);
      await iterable.$release();
    } finally {
      await venv.close();
    }
  }, 120_000);

  test('cleans up an unexpectedly exited Python worker', async () => {
    const venv = createVenv({ autoClose: false, project: false });
    try {
      const fixture = await venv.import('tests.fixtures.bridge_fixture');

      await expect(fixture.terminate_worker()).rejects.toThrow(/disconnected|exited unexpectedly/u);
      expect(await waitFor(() => venv.closed)).toBe(true);
      expect(venv.started).toBe(false);
    } finally {
      await venv.close();
    }
  }, 120_000);

  test('validates deserialized models with Pydantic by default', async () => {
    const venv = createVenv({
      autoClose: false,
      project: false,
      with: ['pydantic>=2,<3'],
    });
    try {
      const fixture = await venv.import('tests.fixtures.pydantic_fixture');

      expect(await fixture.user_label({ id: '42', name: 'pynect' })).toBe('42:PYNECT');
      expect(await fixture.make_user('7', 'bridge')).toEqual({ id: 7, name: 'BRIDGE' });
    } finally {
      await venv.close();
    }
  }, 120_000);
});

type Fixture = PythonObject;
type Callback = (value: number) => number;

async function passTransientCallback(fixture: Fixture): Promise<WeakRef<Callback>> {
  const callback: Callback = value => value + 1;
  const reference = new WeakRef(callback);
  expect(await fixture.call_callback(callback, 6)).toBe(7);
  return reference;
}

async function storeCallback(fixture: Fixture): Promise<WeakRef<Callback>> {
  const callback: Callback = value => value + 1;
  const reference = new WeakRef(callback);
  await fixture.store_callback(callback);
  await fixture.store_callback(callback);
  return reference;
}

async function rejectCallbackWithCircularArgument(
  fixture: Fixture,
): Promise<WeakRef<Callback>> {
  const callback: Callback = value => value + 1;
  const reference = new WeakRef(callback);
  const circular: Record<string, unknown> = {};
  circular['self'] = circular;
  await expect(fixture.call_callback(callback, circular)).rejects.toThrow('circular');
  return reference;
}

async function waitForCollection(reference: WeakRef<Callback>): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    Bun.gc(true);
    if (!reference.deref()) return true;
    await Bun.sleep(10);
  }
  return !reference.deref();
}

async function waitFor(predicate: () => boolean): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(10);
  }
  return predicate();
}
