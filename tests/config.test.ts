import { describe, expect, test } from 'bun:test';
import { loadConfig, toEnvironmentKey } from '../src/index.ts';

describe('loadConfig', () => {
  test('applies defaults, env, and CLI flags in order', () => {
    const config = loadConfig({
      defaults: { port: 3000, debug: false, logLevel: 'info' },
      env: { CFG_PORT: '4000', CFG_DEBUG: 'true', CFG_LOG_LEVEL: 'warn' },
      argv: ['--port=5000', '--no-debug'],
      prefix: 'CFG_',
    });

    expect(config).toEqual({ port: 5000, debug: false, logLevel: 'warn' });
  });

  test('rejects invalid typed values', () => {
    expect(() => loadConfig({
      defaults: { port: 3000 },
      env: { PORT: 'many' },
      argv: [],
    })).toThrow('must be a finite number');
  });
});

test('translates option and package names to environment keys', () => {
  expect(toEnvironmentKey('@scope/my-app')).toBe('SCOPE_MY_APP');
  expect(toEnvironmentKey('logLevel')).toBe('LOG_LEVEL');
});
