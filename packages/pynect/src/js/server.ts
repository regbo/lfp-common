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
import { OwnedProcessTree } from './process-signals.js';
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
  #pid: number | undefined;
  #tree: OwnedProcessTree | undefined;

  constructor(options: {
    child?: ChildProcess;
    path: string;
    pid?: number | Promise<number>;
    processGroup?: boolean;
  }) {
    this.child = options.child;
    this.clientOptions = ipcClientOptions(options.path);
    this.owned = options.child !== undefined;
    this.path = options.path;
    if (options.child) {
      this.#tree = new OwnedProcessTree(options.child, options.pid, {
        processGroup: options.processGroup ?? false,
      });
      this.exited = this.#tree.exited;
      if (typeof options.pid === 'number') this.#pid = options.pid;
      else if (options.pid) {
        void options.pid.then(pid => { this.#pid = pid; }, () => undefined);
      }
    } else {
      this.exited = Promise.resolve(null);
      if (typeof options.pid === 'number') this.#pid = options.pid;
    }
  }

  get pid(): number | undefined {
    return this.#pid;
  }

  /** Wait until the Python worker exits. */
  wait(): Promise<number | null> {
    return this.exited;
  }

  /** Stop an owned worker. Concurrent calls share the same shutdown operation. */
  close(): Promise<void> {
    return this.#tree?.close() ?? Promise.resolve();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/** Start a parent-owned Python IPC server and return its Chanx client options. */
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
    detached: process.platform !== 'win32',
    env: {
      PYNECT_APP: project.app,
      PYNECT_IPC_PATH: ipcPath,
      PYNECT_PARENT_PID: String(process.pid),
      PYTHONUNBUFFERED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr?.pipe(stderr, { end: false });

  let server: IpcServer | undefined;
  try {
    if (!child.stdout) throw new Error('Python IPC server stdout is unavailable.');
    const pid = captureServerPid(child.stdout, stdout, parsed.startupTimeoutMs);
    server = new IpcServer({
      child,
      path: ipcPath,
      pid,
      processGroup: process.platform !== 'win32',
    });
    await pid;
    await waitForIpc(ipcPath, child, parsed.startupTimeoutMs);
    return server;
  } catch (error) {
    if (server) await server.close();
    else if (child.exitCode === null && child.signalCode === null) child.kill();
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

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
