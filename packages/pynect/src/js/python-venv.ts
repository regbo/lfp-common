import type { ChildProcess } from 'node:child_process';
import { Mutex } from 'async-mutex';
import type { PythonContext } from 'pyfig';
import {
  resolveVenvOptions,
  type CreateVenvOptions,
  type ResolvedVenvOptions,
} from './config';
import { VenvClosedError, VenvStartupError } from './errors';
import {
  FORWARD_SIGNAL,
  trackProcessLifecycle,
  type TerminationSignal,
  untrackProcessLifecycle,
} from './process-lifecycle';
import { RPC_OPERATION } from './protocol';
import type { PythonObject } from './python-object';
import { PythonWorker, startPythonWorker } from './python-worker';
import { RpcClient } from './rpc-client';
import { SocketRpcTransport } from './transport/socket-rpc';

interface VenvInfo {
  readonly environment: PythonContext;
  readonly modules: Readonly<Record<string, string>>;
  readonly project: string | false | undefined;
}

interface StartedVenv {
  readonly client: RpcClient;
  readonly info: VenvInfo;
  readonly worker: PythonWorker;
}

/** A lazily started, uv-backed Python environment and object bridge. */
export class PythonVenv<Modules extends object = object> implements AsyncDisposable {
  readonly #options: ResolvedVenvOptions;
  readonly #mutex = new Mutex();
  #closeRequested = false;
  #pendingSignal: TerminationSignal | undefined;
  #runtime: StartedVenv | undefined;
  #signaledChild: ChildProcess | undefined;
  #startingChild: ChildProcess | undefined;
  #state?: 'starting' | 'started' | 'closed';

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
  import(name: string): Promise<PythonObject>;
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
    await this.#close();
  }

  async [FORWARD_SIGNAL](signal: TerminationSignal): Promise<void> {
    this.#pendingSignal ??= signal;
    if (this.#startingChild) this.#signalChild(this.#startingChild, this.#pendingSignal);
    await this.#close(this.#pendingSignal);
  }

  async #close(signal?: TerminationSignal): Promise<void> {
    this.#closeRequested = true;
    await this.#mutex.runExclusive(async () => {
      if (this.#state === 'closed') return;
      this.#state = 'closed';
      const runtime = this.#runtime;
      if (!runtime) {
        untrackProcessLifecycle(this);
        return;
      }
      try {
        if (
          signal && runtime.worker.child.exitCode === null &&
          runtime.worker.child.signalCode === null
        ) {
          this.#signalChild(runtime.worker.child, signal);
        }
        await runtime.client.close();
        await runtime.worker.close(runtime.client.pythonPid);
      } finally {
        untrackProcessLifecycle(this);
        this.#runtime = undefined;
      }
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  forceClose(): void {
    this.#closeRequested = true;
    this.#state = 'closed';
    if (this.#startingChild) this.#startingChild.kill();
    const runtime = this.#runtime;
    if (runtime) {
      runtime.client.forceClose();
      runtime.worker.forceClose();
    }
    untrackProcessLifecycle(this);
  }

  #start(): Promise<StartedVenv> {
    if (this.#state === 'closed' || this.#closeRequested) {
      return Promise.reject(new VenvClosedError());
    }
    if (this.#runtime) return Promise.resolve(this.#runtime);
    this.#trackStart();
    return this.#mutex.runExclusive(async () => {
      if (this.#state === 'closed') return undefined;
      if (this.#runtime) return this.#runtime;
      this.#trackStart();
      try {
        this.#assertStartupAllowed();
        const runtime = await this.#startRuntime();
        this.#runtime = runtime;
        this.#state = 'started';
        this.#watchRuntime(runtime);
        return runtime;
      } catch (error) {
        this.#state = this.#closeRequested ? 'closed' : undefined;
        untrackProcessLifecycle(this);
        throw error;
      }
    }).then(runtime => {
      if (!runtime) throw new VenvClosedError();
      return runtime;
    });
  }

  #trackStart(): void {
    if (this.#state !== undefined) return;
    this.#state = 'starting';
    trackProcessLifecycle(this);
  }

  #assertStartupAllowed(): void {
    if (this.#closeRequested) throw new VenvClosedError();
  }

  #signalChild(child: ChildProcess, signal: TerminationSignal): void {
    if (this.#signaledChild === child || child.exitCode !== null || child.signalCode !== null) return;
    try {
      // uv forwards catchable termination signals to the Python process on Unix.
      // Windows console signals already reach Python; this also terminates uv.
      if (child.kill(signal)) this.#signaledChild = child;
    } catch {
      // Graceful RPC shutdown remains the cross-platform fallback after handshake.
    }
  }

  #watchRuntime(runtime: StartedVenv): void {
    runtime.worker.child.once('exit', (code, signal) => {
      if (this.#state === 'closed') return;
      runtime.client.forceClose(new VenvClosedError(
        `Python worker exited unexpectedly (${signal ?? `code ${code ?? 'unknown'}`}).`,
      ));
      this.#state = 'closed';
      this.#runtime = undefined;
      untrackProcessLifecycle(this);
      runtime.worker.forceClose();
    });
  }

  async #startRuntime(): Promise<StartedVenv> {
    let worker: PythonWorker | undefined;

    try {
      worker = await startPythonWorker(this.#options, {
        assertOpen: () => this.#assertStartupAllowed(),
        childWasSignaled: child => this.#signaledChild === child,
        onChild: child => {
          this.#startingChild = child;
          if (this.#pendingSignal) this.#signalChild(child, this.#pendingSignal);
        },
      });
      const client = await RpcClient.connect({
        autoUnref: this.#options.autoClose,
        callTimeoutMs: this.#options.callTimeoutMs,
        transport: new SocketRpcTransport(worker.socket),
        timeoutMs: this.#options.startupTimeoutMs,
        token: worker.token,
      });
      if (this.#options.autoClose) worker.unref();
      const runtime: StartedVenv = {
        client,
        info: Object.freeze({
          environment: worker.environment,
          modules: this.#options.modules,
          project: this.#options.project,
        }),
        worker,
      };
      return runtime;
    } catch (error) {
      if (worker) {
        if (this.#signaledChild === worker.child) await worker.close();
        else worker.forceClose();
      }
      if (this.#closeRequested) throw new VenvClosedError();
      throw new VenvStartupError('Could not start the Python worker.', { cause: error });
    } finally {
      this.#startingChild = undefined;
    }
  }
}

/** Create a lazy Venv. No Python or uv process starts until the first operation. */
export function createVenv<Modules extends object = object>(
  options: CreateVenvOptions = {},
): PythonVenv<Modules> {
  return new PythonVenv<Modules>(options);
}
