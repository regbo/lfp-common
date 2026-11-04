import { randomBytes } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import os from 'node:os';
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
import { resolvePythonPath } from './utils/pyfig';
import { resolvePythonScript } from './utils/python-script';

const WORKER_REQUIREMENT = 'msgpack>=1.1,<2';
const FORWARD_SIGNAL = Symbol('pynect.forwardSignal');
type TerminationSignal = 'SIGHUP' | 'SIGINT' | 'SIGQUIT' | 'SIGTERM' | 'SIGBREAK';
const terminationSignals: readonly TerminationSignal[] = process.platform === 'win32'
  ? ['SIGHUP', 'SIGINT', 'SIGTERM', 'SIGBREAK']
  : ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGTERM'];

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
    await this.#close();
  }

  async [FORWARD_SIGNAL](signal: TerminationSignal): Promise<void> {
    this.#pendingSignal ??= signal;
    if (this.#startingChild) this.#signalChild(this.#startingChild, this.#pendingSignal);
    await this.#close(this.#pendingSignal);
  }

  async #close(signal?: TerminationSignal): Promise<void> {
    this.#closeRequested = true;
    await withLock(
      this,
      venv => venv.#state !== 'closed',
      async venv => {
        venv.#state = 'closed';
        const runtime = venv.#runtime;
        if (!runtime) {
          activeVenvs.delete(venv);
          if (activeVenvs.size === 0) unregisterExitHooks();
          return;
        }
        try {
          if (signal && runtime.child.exitCode === null && runtime.child.signalCode === null) {
            venv.#signalChild(runtime.child, signal);
          }
          await runtime.client.close();
          await terminateChild(runtime.child);
          await terminateProcess(runtime.client.pythonPid);
          await runtime.transport.close();
        } finally {
          activeVenvs.delete(venv);
          venv.#runtime = undefined;
          if (activeVenvs.size === 0) unregisterExitHooks();
        }
      },
    );
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
      runtime.child.kill();
    }
    activeVenvs.delete(this);
    if (activeVenvs.size === 0) unregisterExitHooks();
  }

  #start(): Promise<StartedVenv> {
    if (this.#state === 'closed' || this.#closeRequested) {
      return Promise.reject(new VenvClosedError());
    }
    if (this.#runtime) return Promise.resolve(this.#runtime);
    this.#trackStart();
    return withLock(
      this,
      venv => venv.#state !== 'closed',
      async venv => {
        if (venv.#runtime) return venv.#runtime;
        venv.#trackStart();
        try {
          venv.#assertStartupAllowed();
          const runtime = await venv.#startRuntime();
          venv.#runtime = runtime;
          venv.#state = 'started';
          venv.#watchRuntime(runtime);
          return runtime;
        } catch (error) {
          venv.#state = venv.#closeRequested ? 'closed' : undefined;
          activeVenvs.delete(venv);
          if (activeVenvs.size === 0) unregisterExitHooks();
          throw error;
        }
      },
    ).then(runtime => {
      if (!runtime) throw new VenvClosedError();
      return runtime;
    });
  }

  #trackStart(): void {
    if (this.#state !== undefined) return;
    this.#state = 'starting';
    activeVenvs.add(this);
    registerExitHooks();
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
    runtime.child.once('exit', (code, signal) => {
      if (this.#state === 'closed') return;
      runtime.client.forceClose(new VenvClosedError(
        `Python worker exited unexpectedly (${signal ?? `code ${code ?? 'unknown'}`}).`,
      ));
      this.#state = 'closed';
      this.#runtime = undefined;
      activeVenvs.delete(this);
      if (activeVenvs.size === 0) unregisterExitHooks();
      void runtime.transport.close();
    });
  }

  async #startRuntime(): Promise<StartedVenv> {
    this.#assertStartupAllowed();
    const environment = await pyfig(this.#options.pyfig);
    this.#assertStartupAllowed();
    const pythonPath = await resolvePythonPath(environment);
    this.#assertStartupAllowed();
    const transport = await LocalIpcServer.listen();
    const token = randomBytes(32).toString('hex');
    let child: ChildProcess | undefined;

    try {
      this.#assertStartupAllowed();
      child = await environment.uv.spawn(
        ...buildUvArguments(this.#options, pythonPath),
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
      this.#startingChild = child;
      if (this.#pendingSignal) this.#signalChild(child, this.#pendingSignal);
      this.#assertStartupAllowed();

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
      return runtime;
    } catch (error) {
      if (child) {
        if (this.#signaledChild !== child) child.kill();
        await terminateChild(child);
      }
      await transport.close();
      if (this.#closeRequested) throw new VenvClosedError();
      throw new VenvStartupError('Could not start the Python worker.', { cause: error });
    } finally {
      if (this.#startingChild === child) this.#startingChild = undefined;
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
  pythonPath: string,
): string[] {
  const args = ['run', '--quiet'];
  if (options.project === false) args.push('--no-project');
  else if (typeof options.project === 'string') args.push('--project', options.project);
  args.push('--python', pythonPath);
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
  return resolvePythonScript(__dirname, 'pynect_worker.py');
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

let naturalExitCleanup: Promise<void> | undefined;
let signalCleanup: Promise<void> | undefined;
let exitHooksRegistered = false;
const signalHandlers = new Map<TerminationSignal, () => void>(
  terminationSignals.map(signal => [signal, () => { void handleTerminationSignal(signal); }]),
);

function registerExitHooks(): void {
  if (exitHooksRegistered) return;
  exitHooksRegistered = true;
  process.on('beforeExit', handleBeforeExit);
  process.once('exit', handleExit);
  for (const [signal, handler] of signalHandlers) process.on(signal, handler);
}

function unregisterExitHooks(): void {
  if (!exitHooksRegistered) return;
  exitHooksRegistered = false;
  process.off('beforeExit', handleBeforeExit);
  process.off('exit', handleExit);
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
}

function handleBeforeExit(): void {
  if (activeVenvs.size > 0) void closeActiveVenvsForNaturalExit();
}

function handleExit(): void {
  for (const venv of activeVenvs) venv.forceClose();
}

function closeActiveVenvs(signal?: TerminationSignal): Promise<void> {
  const venvs = [...activeVenvs];
  return Promise.allSettled(venvs.map(venv => signal ? venv[FORWARD_SIGNAL](signal) : venv.close()))
    .then(() => undefined);
}

function handleTerminationSignal(signal: TerminationSignal): Promise<void> {
  if (signalCleanup) return signalCleanup;
  signalCleanup = closeActiveVenvs(signal).finally(() => {
    process.exit(128 + (os.constants.signals[signal] ?? 1));
  });
  return signalCleanup;
}

function closeActiveVenvsForNaturalExit(): Promise<void> {
  if (!naturalExitCleanup) naturalExitCleanup = closeActiveVenvs();
  return naturalExitCleanup;
}
