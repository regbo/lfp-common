import { describe, expect, test } from 'bun:test';
import { ProcessSignalForwarder } from '../src/process-signals.js';

describe('ProcessSignalForwarder', () => {
  test('signals an isolated POSIX worker group', () => {
    const calls: Array<[number, NodeJS.Signals]> = [];
    const signals = new ProcessSignalForwarder(101, {
      kill: (pid, signal) => {
        calls.push([pid, signal]);
        return true;
      },
      platform: 'darwin',
      processGroup: true,
    });

    signals.forward('SIGINT', true);
    signals.forceKill();

    expect(calls).toEqual([
      [-101, 'SIGINT'],
      [-101, 'SIGKILL'],
    ]);
  });

  test('lets Windows deliver native console events to its existing child', () => {
    const calls: Array<[number, NodeJS.Signals]> = [];
    const signals = new ProcessSignalForwarder(101, {
      kill: (pid, signal) => {
        calls.push([pid, signal]);
        return true;
      },
      platform: 'win32',
    });

    signals.forward('SIGINT', true);
    signals.forward('SIGTERM');

    expect(calls).toEqual([[101, 'SIGTERM']]);
  });
});
