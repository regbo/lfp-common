import { randomBytes } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import type { Socket } from 'node:net';
import { pyfig, type PythonContext } from 'pyfig';
import type { ResolvedVenvOptions } from './config';
import { LocalIpcServer } from './transport/local-ipc';
import { resolvePythonPath } from './utils/pyfig';
import { resolvePythonPackage } from './utils/python-package';

export interface StartPythonWorkerHooks {
  readonly assertOpen?: () => void;
  readonly childWasSignaled?: (child: ChildProcess) => boolean;
  readonly onChild?: (child: ChildProcess) => void;
}

/** A spawned Python worker before an RPC client claims its local connection. */
export class PythonWorker {
  readonly child: ChildProcess;
  readonly environment: PythonContext;
  readonly socket: Socket;
  readonly token: string;
  readonly #transport: LocalIpcServer;
  #closed = false;

  constructor(options: {
    readonly child: ChildProcess;
    readonly environment: PythonContext;
    readonly socket: Socket;
    readonly token: string;
    readonly transport: LocalIpcServer;
  }) {
    this.child = options.child;
    this.environment = options.environment;
    this.socket = options.socket;
    this.token = options.token;
    this.#transport = options.transport;
  }

  unref(): void {
    this.child.unref();
    this.#transport.unref();
  }

  async close(pythonPid?: number): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.socket.destroy();
    await terminateChild(this.child);
    if (pythonPid !== undefined) await terminateProcess(pythonPid);
    await this.#transport.close();
  }

  forceClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.socket.destroy();
    this.child.kill();
    void this.#transport.close();
  }
}

/** Resolve uv/Python, spawn the worker, and accept its private IPC connection. */
export async function startPythonWorker(
  options: ResolvedVenvOptions,
  hooks: StartPythonWorkerHooks = {},
): Promise<PythonWorker> {
  hooks.assertOpen?.();
  const environment = await pyfig(options.pyfig);
  hooks.assertOpen?.();
  const pythonPath = await resolvePythonPath(environment);
  hooks.assertOpen?.();
  const transport = await LocalIpcServer.listen();
  const token = randomBytes(32).toString('hex');
  let child: ChildProcess | undefined;
  let socket: Socket | undefined;

  try {
    hooks.assertOpen?.();
    child = await environment.uv.spawn(
      ...buildUvArguments(options, pythonPath),
      {
        cwd: options.cwd,
        env: {
          ...options.env,
          PYNECT_CWD: options.cwd,
          PYNECT_ENDPOINT: transport.endpoint,
          PYNECT_PARENT_PID: String(process.pid),
          PYNECT_TOKEN: token,
          PYNECT_VALIDATE_PYDANTIC: options.validatePydantic ? '1' : '0',
          PYTHONUNBUFFERED: '1',
        },
        stdio: ['ignore', 'inherit', 'inherit'],
        windowsHide: true,
      },
    );
    hooks.onChild?.(child);
    hooks.assertOpen?.();
    socket = await waitForWorkerConnection(transport, child, options.startupTimeoutMs);
    hooks.assertOpen?.();
    return new PythonWorker({ child, environment, socket, token, transport });
  } catch (error) {
    socket?.destroy();
    if (child) {
      if (!hooks.childWasSignaled?.(child)) child.kill();
      await terminateChild(child);
    }
    await transport.close();
    throw error;
  }
}

function buildUvArguments(
  options: ResolvedVenvOptions,
  pythonPath: string,
): string[] {
  const args = ['run', '--quiet'];
  if (options.project === false) args.push('--no-project');
  else if (typeof options.project === 'string') args.push('--project', options.project);
  args.push('--python', pythonPath);
  const worker = resolvePythonPackage(__dirname);
  args.push(worker.editable ? '--with-editable' : '--with', worker.requirement);
  for (const requirement of options.with) {
    args.push('--with', requirement);
  }
  for (const requirement of options.withEditable) {
    args.push('--with-editable', requirement);
  }
  for (const requirement of options.withRequirements) {
    args.push('--with-requirements', requirement);
  }
  args.push(...options.uvArgs);
  args.push('--', 'python', '-m', 'pynect_worker.bridge');
  return args;
}

function waitForWorkerConnection(
  transport: LocalIpcServer,
  child: ChildProcess,
  timeoutMs: number,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => settle(() => reject(error));
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      settle(() => reject(new Error(
        `uv exited before the Python worker connected (${signal ?? `code ${code ?? 'unknown'}`}).`,
      )));
    };
    let settled = false;
    const settle = (handler: () => void): void => {
      if (settled) return;
      settled = true;
      child.off('error', onError);
      child.off('exit', onExit);
      handler();
    };
    child.once('error', onError);
    child.once('exit', onExit);
    void transport.waitForConnection(timeoutMs).then(
      socket => settle(() => resolve(socket)),
      error => settle(() => reject(error)),
    );
  });
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (await waitForChildExit(child, 2_000)) return;
  child.kill();
  if (await waitForChildExit(child, 2_000)) return;
  child.kill('SIGKILL');
  await waitForChildExit(child, 2_000);
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

async function terminateProcess(pid: number): Promise<void> {
  if (await waitForProcessExit(pid, 2_000)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return;
  }
  await waitForProcessExit(pid, 2_000);
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await new Promise<void>(resolve => {
      setTimeout(resolve, 25);
    });
  }
  return !isProcessAlive(pid);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
