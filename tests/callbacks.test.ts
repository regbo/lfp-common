import { describe, expect, test } from 'bun:test';
import { mapType } from '../src/cli/codegen';
import { resolveConfig } from '../src/types/config';

describe('callback configuration and code generation', () => {
  test('uses Python recursion as the default and accepts an explicit maximum', () => {
    expect(resolveConfig().callbackMaxDepth).toBe(0);
    expect(resolveConfig({ callbacks: { maxDepth: 12 } }).callbackMaxDepth).toBe(12);
    expect(() => resolveConfig({ callbacks: { maxDepth: 0 } })).toThrow(/positive integer/);
  });

  test('maps typed Python callables to branded Pynect callbacks', () => {
    expect(mapType('Callable[[int, str], bool]')).toBe(
      'PynectCallback<[number, string], boolean>',
    );
    expect(mapType('Callable[..., Optional[int]]')).toBe(
      'PynectCallback<unknown[], number | null>',
    );
  });
});
