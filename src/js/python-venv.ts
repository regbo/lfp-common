import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { memoize } from 'loqkit';
import { pyfig, type PythonContext } from 'pyfig';
import {
  resolveVenvOptions,
  type CreateVenvOptions,
  type ResolvedVenvOptions,
} from './config';
import { VenvClosedError, VenvStartupError } from './errors';
import { RPC_OPERATION } from './protocol';
import type { PythonModule } from './python-object';
import { RpcClient } from './rpc-client';
import { LocalIpcServer } from './transport/local-ipc';
import { withLock } from './utils/lock';

const WORKER_REQUIREMENT = 'msgpack>=1.1,<2';

export interface PynectModules {}

export interface VenvInfo {
  readonly environment: PythonContext;
  readonly modules: Readonly<Record<string, string>>;
  readonly project: string | false | undefined;
}

interface StartedVenv {
  readonly child: ChildProcess;
  readonly client: RpcClient;
  readonly info: VenvInfo;
  readonly transport: LocalIpcServer;
}

const activeVenvs = new Set<PythonVenv>();

/** A lazily started, uv-backed Python environment and object bridge. */
export class PythonVenv<Modules extends object = PynectModules> implements AsyncDisposable {
  readonly #options: ResolvedVenvOptions;
  #runtime: StartedVenv | undefined;
  #state?: 'started' | 'closed';

  constructor(options: CreateVenvOptions = {}) {
    this.#options = resolveVenvOptions(options);
  }

  get started(): boolean {
    return this.#state === 'started';
  }

  get closed(): boolean {
    return this.#state === 'closed';
  }

  import<Name extends keyof Modules & string>(name: Name): Promise<Modules[Name]>;
  import(name: string): Promise<PythonModule>;
  async import(name: string): Promise<unknown> {
    if (!name.trim()) throw new TypeError('Python module name cannot be empty.');
    const runtime = await this.#start();
    return runtime.client.request(RPC_OPERATION.import, {
      name: this.#options.modules[name] ?? name,
    });
  }

  /** Prepare the environment explicitly without importing a module. */
  async ready(): Promise<VenvInfo> {
    return (await this.#start()).info;
  }

  async close(): Promise<void> {
    await withLock(
      this,
      venv => venv.#state !== 'closed',
      async venv => {
        venv.#state = 'closed';
        const runtime = venv.#runtime;
        if (!runtime) return;
        activeVenvs.delete(venv);
        await runtime.client.close();
        await terminateChild(runtime.child);
        await runtime.transport.close();
        venv.#runtime = undefined;
      },
    );
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  forceClose(): void {
    this.#state = 'closed';
    const runtime = this.#runtime;
    if (!runtime) return;
    runtime.client.forceClose();
    runtime.child.kill();
    activeVenvs.delete(this);
  }

  #start(): Promise<StartedVenv> {
    if (this.#state === 'closed') return Promise.reject(new VenvClosedError());
    if (this.#runtime) return Promise.resolve(this.#runtime);
    return withLock(
      this,
      venv => venv.#state !== 'closed',
      async venv => {
        if (venv.#runtime) return venv.#runtime;
        const runtime = await venv.#startRuntime();
        venv.#runtime = runtime;
        venv.#state = 'started';
        activeVenvs.add(venv);
        registerExitHook();
        return runtime;
      },
    ).then(runtime => {
      if (!runtime) throw new VenvClosedError();
      return runtime;
    });
  }

  async #startRuntime(): Promise<StartedVenv> {
    const environment = await pyfig(this.#options.pyfig);
    const transport = await LocalIpcServer.listen();
    const token = randomBytes(32).toString('hex');
    const child = spawn(
      environment.uv.path,
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
        info: Object.freeze({
          environment,
          modules: this.#options.modules,
          project: this.#options.project,
        }),
        transport,
      };
      child.once('exit', (code, signal) => {
        if (this.#state !== 'closed') {
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
  environment: PythonContext,
): string[] {
  const args = ['run', '--quiet'];
  if (options.project === false) args.push('--no-project');
  else if (typeof options.project === 'string') args.push('--project', options.project);
  args.push('--python', environment.python.path);
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
  return path.resolve(__dirname, '..', 'py', 'pynect_worker.py');
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

const registerExitHook = memoize(() => {
  process.once('exit', () => {
    for (const venv of activeVenvs) venv.forceClose();
  });
});
