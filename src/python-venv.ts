import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { ensurePython, type PythonEnvironment } from 'pyfig';
import {
  resolveVenvOptions,
  type CreateVenvOptions,
  type ResolvedVenvOptions,
} from './config';
import { VenvClosedError, VenvStartupError } from './errors';
import type { PythonModule } from './python-object';
import { RpcClient } from './rpc-client';
import { LocalIpcServer } from './transport/local-ipc';

const WORKER_REQUIREMENT = 'msgpack>=1.1,<2';

export interface PynectModules {}

export interface VenvInfo {
  readonly environment: PythonEnvironment;
  readonly project: string | false | undefined;
}

interface StartedVenv {
  readonly child: ChildProcess;
  readonly client: RpcClient;
  readonly info: VenvInfo;
  readonly transport: LocalIpcServer;
}

const activeVenvs = new Set<PythonVenv>();
let exitHookRegistered = false;

/** A lazily started, uv-backed Python environment and object bridge. */
export class PythonVenv<Modules extends object = PynectModules> implements AsyncDisposable {
  readonly #options: ResolvedVenvOptions;
  #runtime: StartedVenv | undefined;
  #starting: Promise<StartedVenv> | undefined;
  #closed = false;

  constructor(options: CreateVenvOptions = {}) {
    this.#options = resolveVenvOptions(options);
  }

  get started(): boolean {
    return this.#runtime !== undefined;
  }

  get closed(): boolean {
    return this.#closed;
  }

  import<Name extends keyof Modules & string>(name: Name): Promise<Modules[Name]>;
  import(name: string): Promise<PythonModule>;
  async import(name: string): Promise<unknown> {
    if (!name.trim()) throw new TypeError('Python module name cannot be empty.');
    const runtime = await this.#start();
    return runtime.client.request('import', { name });
  }

  /** Prepare the environment explicitly without importing a module. */
  async ready(): Promise<VenvInfo> {
    return (await this.#start()).info;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const runtime = this.#runtime ?? (this.#starting ? await this.#starting.catch(() => undefined) : undefined);
    if (!runtime) return;
    activeVenvs.delete(this);
    await runtime.client.close();
    await terminateChild(runtime.child);
    await runtime.transport.close();
    this.#runtime = undefined;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  forceClose(): void {
    const runtime = this.#runtime;
    if (!runtime) return;
    runtime.client.forceClose();
    runtime.child.kill();
    activeVenvs.delete(this);
  }

  #start(): Promise<StartedVenv> {
    if (this.#closed) return Promise.reject(new VenvClosedError());
    if (this.#runtime) return Promise.resolve(this.#runtime);
    this.#starting ??= this.#startRuntime().then(runtime => {
      if (this.#closed) {
        runtime.client.forceClose();
        runtime.child.kill();
        void runtime.transport.close();
        throw new VenvClosedError();
      }
      this.#runtime = runtime;
      activeVenvs.add(this);
      registerExitHook();
      return runtime;
    }).finally(() => {
      this.#starting = undefined;
    });
    return this.#starting;
  }

  async #startRuntime(): Promise<StartedVenv> {
    const environment = await ensurePython(this.#options.pyfig);
    const transport = await LocalIpcServer.listen();
    const token = randomBytes(32).toString('hex');
    const child = spawn(
      environment.uv.executable,
      buildUvArguments(this.#options, environment),
      {
        cwd: this.#options.cwd,
        env: {
          ...this.#options.env,
          PYNECT_CWD: this.#options.cwd,
          PYNECT_ENDPOINT: transport.endpoint,
          PYNECT_PARENT_PID: String(process.pid),
          PYNECT_TOKEN: token,
          PYNECT_VALIDATE_PYDANTIC: this.#options.validatePydantic ? '1' : '0',
          PYTHONUNBUFFERED: '1',
        },
        stdio: ['ignore', 'inherit', 'inherit'],
        windowsHide: true,
      },
    );

    try {
      const socket = await Promise.race([
        transport.waitForConnection(this.#options.startupTimeoutMs),
        childFailure(child),
      ]);
      const client = await RpcClient.connect({
        autoUnref: this.#options.autoClose,
        callTimeoutMs: this.#options.callTimeoutMs,
        socket,
        timeoutMs: this.#options.startupTimeoutMs,
        token,
      });
      if (this.#options.autoClose) {
        child.unref();
        transport.unref();
      }
      const runtime: StartedVenv = {
        child,
        client,
        info: Object.freeze({ environment, project: this.#options.project }),
        transport,
      };
      child.once('exit', (code, signal) => {
        if (!this.#closed) {
          client.forceClose(new VenvClosedError(
            `Python worker exited unexpectedly (${signal ?? `code ${code ?? 'unknown'}`}).`,
          ));
        }
      });
      return runtime;
    } catch (error) {
      child.kill();
      await transport.close();
      throw new VenvStartupError('Could not start the Python worker.', { cause: error });
    }
  }
}

/** Create a lazy Venv. No Python or uv process starts until the first operation. */
export function createVenv<Modules extends object = PynectModules>(
  options: CreateVenvOptions = {},
): PythonVenv<Modules> {
  return new PythonVenv<Modules>(options);
}

function buildUvArguments(
  options: ResolvedVenvOptions,
  environment: PythonEnvironment,
): string[] {
  const args = ['run', '--quiet'];
  if (options.project === false) args.push('--no-project');
  else if (typeof options.project === 'string') args.push('--project', options.project);
  args.push('--python', environment.python.executable);
  for (const requirement of [WORKER_REQUIREMENT, ...options.with]) {
    args.push('--with', requirement);
  }
  for (const requirement of options.withEditable) {
    args.push('--with-editable', requirement);
  }
  for (const requirement of options.withRequirements) {
    args.push('--with-requirements', requirement);
  }
  args.push(...options.uvArgs);
  args.push('--', 'python', resolveWorkerPath());
  return args;
}

function resolveWorkerPath(): string {
  return path.resolve(__dirname, '..', 'python', 'pynect_worker.py');
}

function childFailure(child: ChildProcess): Promise<never> {
  return new Promise((_, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      reject(new Error(
        `uv exited before the Python worker connected (${signal ?? `code ${code ?? 'unknown'}`}).`,
      ));
    });
  });
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  const exited = await Promise.race([
    new Promise<boolean>(resolve => child.once('exit', () => resolve(true))),
    new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), 2_000);
      timer.unref();
    }),
  ]);
  if (!exited && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

function registerExitHook(): void {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.once('exit', () => {
    for (const venv of activeVenvs) venv.forceClose();
  });
}
