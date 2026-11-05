import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { forwardedProcessSignals } from '../src/process-signals.js';
import { startWorker } from '../src/worker.js';
import { startExampleWorker } from '../../../py/pynect-example/stdio-worker.js';
import {
  connectModelCatalog,
  listModels,
} from '../../../py/pynect-example/client.js';

describe('owned stdio worker', () => {
  test('rejects startup when the child exits before hello', async () => {
    const repositoryRoot = path.resolve(import.meta.dir, '../../../..');
    let error: unknown;
    try {
      await startWorker({
        // Bun is executable but cannot run the Python launcher passed through `-c`.
        python: process.execPath,
        root: path.resolve(import.meta.dir, '../../../py/pynect'),
        app: 'tests.fixtures.catalog:app',
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        startupTimeoutMs: 5_000,
      });
    } catch (cause) {
      error = cause;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/stdout ended unexpectedly|exited with code 1/u);
    expect((error as Error).message).toContain('Python stderr:');
    expect((error as Error).message).toMatch(/(?:File|Script) not found/u);
  }, 60_000);

  test('reports its PID before the application import completes', async () => {
    const stderr = new PassThrough();
    let errorOutput = '';
    stderr.setEncoding('utf8');
    stderr.on('data', chunk => { errorOutput += chunk; });
    const repositoryRoot = path.resolve(import.meta.dir, '../../../..');
    const worker = await startWorker({
      python: path.join(
        repositoryRoot,
        '.venv',
        process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
      ),
      root: path.resolve(import.meta.dir, '../../../py/pynect'),
      app: 'tests.fixtures.delayed_import:app',
      stdout: new PassThrough(),
      stderr,
    });
    const release = await waitForImportBarrier(() => errorOutput);
    try {
      expect(path.basename(release)).toContain(String(worker.pid));
      expect(existsSync(release)).toBe(false);
      await writeFile(release, 'continue');
      const connection = connectModelCatalog(worker.clientOptions);
      try {
        expect((await listModels(connection, { provider: 'anthropic' })).length).toBeGreaterThan(0);
      } finally {
        connection.close();
      }
    } finally {
      await rm(release, { force: true });
      await worker.close();
    }
  }, 60_000);

  test('fails an open virtual socket when the Python application exits', async () => {
    const repositoryRoot = path.resolve(import.meta.dir, '../../../..');
    const worker = await startWorker({
      python: path.join(
        repositoryRoot,
        '.venv',
        process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
      ),
      root: path.resolve(import.meta.dir, '../../../py/pynect'),
      app: 'tests.fixtures.failing_app:app',
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    try {
      const socketFactory = worker.clientOptions.socketFactory;
      if (!socketFactory) throw new Error('stdio client options did not provide a socket factory.');
      const socket = socketFactory('ws://pynect-stdio/ws/failure');
      const failed = Promise.withResolvers<unknown>();
      socket.onerror = failed.resolve;

      expect(await failed.promise).toBeInstanceOf(Error);
      expect(await worker.wait()).not.toBe(0);
    } finally {
      await worker.close();
    }
  }, 60_000);

  test('runs a real generated client and cleans up its process listeners', async () => {
    const initialSignalListeners = new Map(
      forwardedProcessSignals.map(signal => [signal, process.listenerCount(signal)]),
    );
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let output = '';
    let errorOutput = '';
    stdout.setEncoding('utf8');
    stdout.on('data', chunk => { output += chunk; });
    stderr.setEncoding('utf8');
    stderr.on('data', chunk => { errorOutput += chunk; });

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
    expect(output).not.toContain('Disconnecting websocket');
    expect(errorOutput).not.toContain('Disconnecting websocket');
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
      root: path.resolve(import.meta.dir, '../../../py/pynect'),
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
    const workerRoot = path.resolve(import.meta.dir, '../../../py/pynect');
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

async function waitForImportBarrier(readOutput: () => string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const match = /^PYNECT_IMPORT_BARRIER=(.+)$/mu.exec(readOutput());
    if (match?.[1]) return match[1].trim();
    await Bun.sleep(10);
  }
  throw new Error(`Python did not report its import barrier. Stderr: ${readOutput()}`);
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
