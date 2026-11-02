import { describe, expect, test } from 'bun:test';
import * as pynect from '../src';

describe('bridge-owned public API', () => {
  test('exports one bridge factory without singleton lifecycle wrappers', () => {
    expect(typeof pynect.createPythonBridge).toBe('function');
    for (const name of [
      'init',
      'shutdown',
      'py',
      'getRuntime',
      'isInitialized',
      'importModule',
      'callIsolated',
    ]) {
      expect(name in pynect).toBe(false);
    }
  });
});
