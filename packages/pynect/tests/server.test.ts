import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { canConnectIpc } from '../src/js/ipc.js';
import { forwardedProcessSignals } from '../src/js/process-signals.js';
import { startIpcServer } from '../src/js/server.js';

describe('Pyfig IPC server', () => {
  test('captures the Python PID, forwards later output, and disposes the server', async () => {
    const initialSignalListeners = new Map(
      forwardedProcessSignals.map(signal => [signal, process.listenerCount(signal)]),
    );
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let output = '';
    let errorOutput = '';
    stdout.setEncoding('utf8');
    stderr.setEncoding('utf8');
    stdout.on('data', chunk => { output += chunk; });
    stderr.on('data', chunk => { errorOutput += chunk; });
    const name = `pynect-integration-${process.pid}-${Date.now()}`;
    const server = await startIpcServer({
      root: path.resolve(import.meta.dir, '..'),
      app: 'tests.fixtures.catalog:app',
      debug: true,
      name,
      stdout,
      stderr,
      startupTimeoutMs: 30_000,
    });

    expect(server.owned).toBe(true);
    expect(server.pid).toBeNumber();
    expect(server.pid && isProcessAlive(server.pid)).toBe(true);
    expect(await canConnectIpc(server.path)).toBe(true);
    expect(errorOutput).toContain('IPC server listening at');
    expect(output).not.toContain('#IPC_SERVER_PID#');
    for (const signal of forwardedProcessSignals) {
      expect(process.listenerCount(signal)).toBe((initialSignalListeners.get(signal) ?? 0) + 1);
    }

    const pid = server.pid!;
    const exited = server.wait();
    await Promise.all([server.close(), server.close()]);
    await exited;
    expect(server.child?.exitCode !== null || server.child?.signalCode !== null).toBe(true);
    expect(isProcessAlive(pid)).toBe(false);
    for (const signal of forwardedProcessSignals) {
      expect(process.listenerCount(signal)).toBe(initialSignalListeners.get(signal) ?? 0);
    }
  }, 60_000);

  test('stops the Python worker when its owning process is killed', async () => {
    const marker = '#OWNED_IPC_SERVER#';
    const owner = spawn(process.execPath, ['--eval', `
      import { startIpcServer } from './src/js/server.ts';
      const server = await startIpcServer({
        root: process.cwd(),
        app: 'tests.fixtures.catalog:app',
        name: 'pynect-parent-lifecycle-${process.pid}-${Date.now()}',
      });
      console.log('${marker}' + JSON.stringify({ path: server.path, pid: server.pid }));
      await server.wait();
    `], {
      cwd: path.resolve(import.meta.dir, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let workerPid: number | undefined;
    try {
      const details = await readMarkedJson(owner.stdout, marker);
      workerPid = details.pid;
      expect(isProcessAlive(workerPid)).toBe(true);
      expect(await canConnectIpc(details.path)).toBe(true);

      owner.kill('SIGKILL');
      await waitForProcessExit(workerPid, 5_000);
      expect(isProcessAlive(workerPid)).toBe(false);
      expect(await canConnectIpc(details.path)).toBe(false);
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL');
      if (workerPid !== undefined && isProcessAlive(workerPid)) {
        process.kill(workerPid, 'SIGKILL');
      }
    }
  }, 60_000);
});

function readMarkedJson(
  stream: NodeJS.ReadableStream | null,
  marker: string,
): Promise<{ path: string; pid: number }> {
  if (!stream) throw new Error('Owner process stdout is unavailable.');
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(
      `Owner process did not report its server within 30 seconds. Output: ${output}`,
    )), 30_000);
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      output += chunk;
      const line = output.split(/\r?\n/u).find(candidate => candidate.startsWith(marker));
      if (!line) return;
      clearTimeout(timer);
      resolve(JSON.parse(line.slice(marker.length)));
    });
    stream.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid) && Date.now() < deadline) await Bun.sleep(50);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
