import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { forwardedProcessSignals } from '../src/process-signals.js';
import { startWorker } from '../src/worker.js';
import { startExampleWorker } from '../../../py/pynect-worker-example/stdio-worker.js';
import {
  connectModelCatalog,
  listModels,
} from '../../../py/pynect-worker-example/client.js';

describe('owned stdio worker', () => {
  test('runs a real generated client and cleans up its process listeners', async () => {
    const initialSignalListeners = new Map(
      forwardedProcessSignals.map(signal => [signal, process.listenerCount(signal)]),
    );
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let output = '';
    stdout.setEncoding('utf8');
    stdout.on('data', chunk => { output += chunk; });

    const worker = await startExampleWorker({ stdout, stderr });
    expect(worker.pid).toBeNumber();
    expect(isProcessAlive(worker.pid)).toBe(true);
    expect(output).not.toContain('@pynect:');
    for (const signal of forwardedProcessSignals) {
      expect(process.listenerCount(signal)).toBe((initialSignalListeners.get(signal) ?? 0) + 1);
    }

    const connection = connectModelCatalog(worker.clientOptions);
    try {
      const models = await listModels(connection, { provider: 'openai' });
      expect(models.every(model => model.provider === 'openai')).toBe(true);
    } finally {
      connection.close();
    }

    const exited = worker.wait();
    await Promise.all([worker.close(), worker.close()]);
    expect(await exited).toBe(0);
    expect(isProcessAlive(worker.pid)).toBe(false);
    for (const signal of forwardedProcessSignals) {
      expect(process.listenerCount(signal)).toBe(initialSignalListeners.get(signal) ?? 0);
    }
  }, 60_000);

  test('preserves partial binary stdout and forwards stderr outside the protocol', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const output: Buffer[] = [];
    let errorOutput = '';
    stdout.on('data', chunk => { output.push(Buffer.from(chunk)); });
    stderr.setEncoding('utf8');
    stderr.on('data', chunk => { errorOutput += chunk; });
    const repositoryRoot = path.resolve(import.meta.dir, '../../../..');
    await using worker = await startWorker({
      python: path.join(
        repositoryRoot,
        '.venv',
        process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
      ),
      root: path.resolve(import.meta.dir, '../../../py/pynect-worker'),
      app: 'tests.fixtures.stdio_output:app',
      stdout,
      stderr,
    });

    await worker.close();

    expect(Buffer.compare(
      Buffer.concat(output),
      Buffer.from('partial-without-newline\0'),
    )).toBe(0);
    expect(errorOutput).toContain('stdio fixture stderr');
  }, 60_000);

  test('exits when its sole owning process disappears', async () => {
    const repositoryRoot = path.resolve(import.meta.dir, '../../../..');
    const python = path.join(
      repositoryRoot,
      '.venv',
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
    );
    const workerRoot = path.resolve(import.meta.dir, '../../../py/pynect-worker');
    const marker = '#OWNED_STDIO_WORKER#';
    const owner = spawn(process.execPath, ['--eval', `
      import { startWorker } from './src/worker.ts';
      const worker = await startWorker({
        python: ${JSON.stringify(python)},
        root: ${JSON.stringify(workerRoot)},
        app: 'tests.fixtures.catalog:app',
      });
      console.log('${marker}' + worker.pid);
      await worker.wait();
    `], {
      cwd: path.resolve(import.meta.dir, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let workerPid: number | undefined;
    try {
      workerPid = await readMarkedPid(owner.stdout, marker);
      expect(isProcessAlive(workerPid)).toBe(true);

      owner.kill('SIGKILL');
      await waitForProcessExit(workerPid, 5_000);
      expect(isProcessAlive(workerPid)).toBe(false);
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL');
      if (workerPid !== undefined && isProcessAlive(workerPid)) process.kill(workerPid, 'SIGKILL');
    }
  }, 60_000);
});

function readMarkedPid(stream: NodeJS.ReadableStream | null, marker: string): Promise<number> {
  if (!stream) throw new Error('Owner process stdout is unavailable.');
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(
      `Owner process did not report its worker within 30 seconds. Output: ${output}`,
    )), 30_000);
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      output += chunk;
      const line = output.split(/\r?\n/u).find(candidate => candidate.startsWith(marker));
      if (!line) return;
      clearTimeout(timer);
      resolve(Number(line.slice(marker.length)));
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
