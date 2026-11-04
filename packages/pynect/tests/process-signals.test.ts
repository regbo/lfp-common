import { describe, expect, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  OwnedProcessTree,
  ProcessSignalForwarder,
} from '../src/js/process-signals.js';

describe('ProcessSignalForwarder', () => {
  test('signals a POSIX worker group and replays startup signals to Python', () => {
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
    expect(calls).toEqual([[-101, 'SIGINT']]);

    signals.setPythonPid(202);
    expect(calls).toEqual([
      [-101, 'SIGINT'],
      [202, 'SIGINT'],
    ]);
  });

  test('lets Windows deliver Ctrl+C to existing console children', () => {
    const calls: Array<[number, NodeJS.Signals]> = [];
    const signals = new ProcessSignalForwarder(101, {
      kill: (pid, signal) => {
        calls.push([pid, signal]);
        return true;
      },
      platform: 'win32',
    });
    signals.setPythonPid(202);

    signals.forward('SIGINT', true);

    expect(calls).toEqual([]);
  });

  test('retains a Windows Ctrl+C event for Python discovered afterwards', () => {
    const calls: Array<[number, NodeJS.Signals]> = [];
    const signals = new ProcessSignalForwarder(101, {
      kill: (pid, signal) => {
        calls.push([pid, signal]);
        return true;
      },
      platform: 'win32',
    });

    signals.forward('SIGINT', true);
    expect(calls).toEqual([]);

    signals.setPythonPid(202);
    expect(calls).toEqual([[202, 'SIGINT']]);
  });

  test('explicit Windows shutdown reaches both uv and Python', () => {
    const calls: Array<[number, NodeJS.Signals]> = [];
    const signals = new ProcessSignalForwarder(101, {
      kill: (pid, signal) => {
        calls.push([pid, signal]);
        return true;
      },
      platform: 'win32',
    });
    signals.setPythonPid(202);

    signals.forward('SIGTERM');

    expect(calls).toEqual([
      [101, 'SIGTERM'],
      [202, 'SIGTERM'],
    ]);
  });

  test('the process coordinator retains Ctrl+C until a late Python PID arrives', async () => {
    const calls: Array<[number, NodeJS.Signals]> = [];
    const pid = Promise.withResolvers<number>();
    const child = new EventEmitter() as ChildProcess;
    Object.defineProperties(child, {
      exitCode: { configurable: true, value: null, writable: true },
      pid: { configurable: true, value: 101 },
      signalCode: { configurable: true, value: null, writable: true },
    });
    const externalHandler = (): void => undefined;
    process.on('SIGINT', externalHandler);
    const tree = new OwnedProcessTree(child, pid.promise, {
      kill: (processId, signal) => {
        calls.push([processId, signal]);
        return true;
      },
      platform: 'win32',
    });

    try {
      process.emit('SIGINT', 'SIGINT');
      await Promise.resolve();
      expect(calls).toEqual([]);

      pid.resolve(202);
      await Promise.resolve();
      expect(calls).toEqual([[202, 'SIGINT']]);

      Object.defineProperty(child, 'exitCode', { configurable: true, value: 0 });
      child.emit('close', 0, null);
      await tree.exited;
    } finally {
      process.off('SIGINT', externalHandler);
    }
  });
});
