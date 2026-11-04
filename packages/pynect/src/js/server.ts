import type { ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';
import type { ClientOptions } from '@chanx-js/client';
import { z } from 'zod';
import {
  projectOptionsSchema,
  resolveProject,
  type ProjectOptions,
} from './config.js';
import {
  canConnectIpc,
  defaultIpcPath,
  ipcClientOptions,
} from './ipc.js';
import { captureServerPid } from './pid-handshake.js';
import { spawnWorker } from './python-runtime.js';

const IPC_LAUNCHER = [
  'import os',
  'from pynect_worker.ipc import main',
  "print('#IPC_SERVER_PID#'+str(os.getpid())+'#IPC_SERVER_PID#', flush=True)",
  'main()',
].join('; ');

export const serverOptionsSchema = projectOptionsSchema.unwrap().extend({
  ipcPath: z.string().trim().min(1).optional().describe('Unix socket or Windows pipe path.'),
  startupTimeoutMs: z.number().int().positive().default(30_000)
    .describe('Python PID and socket startup timeout.'),
}).readonly();

export interface StartIpcServerOptions extends ProjectOptions {
  readonly ipcPath?: string;
  readonly startupTimeoutMs?: number;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
}

export class IpcServer implements AsyncDisposable {
  readonly child: ChildProcess | undefined;
  readonly clientOptions: ClientOptions;
  readonly exited: Promise<number | null>;
  readonly owned: boolean;
  readonly path: string;
  readonly pid: number | undefined;
  #closed = false;

  constructor(options: {
    child?: ChildProcess;
    path: string;
    pid?: number;
  }) {
    this.child = options.child;
    this.clientOptions = ipcClientOptions(options.path);
    this.owned = options.child !== undefined;
    this.path = options.path;
    this.pid = options.pid;
    this.exited = options.child
      ? new Promise(resolve => options.child!.once('close', code => resolve(code)))
      : Promise.resolve(null);
  }

  async close(): Promise<void> {
    if (this.#closed || !this.owned) return;
    this.#closed = true;
    if (this.pid !== undefined) await terminateProcess(this.pid);
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill();
    }
    await Promise.race([this.exited, delay(2_000)]);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/** Start a new Python IPC server and return its Chanx client options. */
export async function startIpcServer(
  input: StartIpcServerOptions = {},
): Promise<IpcServer> {
  const parsed = serverOptionsSchema.parse(input);
  const project = resolveProject(parsed);
  const ipcPath = parsed.ipcPath
    ?? process.env[project.ipcEnvironmentVariable]
    ?? defaultIpcPath(project.slug);
  if (await canConnectIpc(ipcPath)) {
    throw new Error(`An IPC server is already listening at ${ipcPath}.`);
  }

  const stdout = input.stdout ?? process.stdout;
  const stderr = input.stderr ?? process.stderr;
  const { child } = await spawnWorker(project, ['-c', IPC_LAUNCHER], {
    env: {
      PYNECT_APP: project.app,
      PYNECT_IPC_PATH: ipcPath,
      PYNECT_PARENT_PID: String(process.pid),
      PYTHONUNBUFFERED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr?.pipe(stderr, { end: false });

  try {
    if (!child.stdout) throw new Error('Python IPC server stdout is unavailable.');
    const pid = await captureServerPid(child.stdout, stdout, parsed.startupTimeoutMs);
    await waitForIpc(ipcPath, child, parsed.startupTimeoutMs);
    return new IpcServer({ child, path: ipcPath, pid });
  } catch (error) {
    child.kill();
    throw error;
  }
}

/** Reuse a running project server or start one owned by this process. */
export async function ensureIpcServer(
  input: StartIpcServerOptions = {},
): Promise<IpcServer> {
  const parsed = serverOptionsSchema.parse(input);
  const project = resolveProject(parsed);
  const ipcPath = parsed.ipcPath
    ?? process.env[project.ipcEnvironmentVariable]
    ?? defaultIpcPath(project.slug);
  if (await canConnectIpc(ipcPath)) return new IpcServer({ path: ipcPath });
  return startIpcServer({ ...input, ipcPath });
}

async function waitForIpc(
  ipcPath: string,
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnectIpc(ipcPath, 100)) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Python IPC server exited before listening at ${ipcPath}.`);
    }
    await delay(25);
  }
  throw new Error(`Python IPC server did not listen at ${ipcPath} within ${timeoutMs} ms.`);
}

async function terminateProcess(pid: number): Promise<void> {
  if (!isProcessAlive(pid)) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  const deadline = Date.now() + 2_000;
  while (isProcessAlive(pid) && Date.now() < deadline) await delay(25);
  if (!isProcessAlive(pid)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
