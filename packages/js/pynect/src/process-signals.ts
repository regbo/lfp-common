import type { ChildProcess } from 'node:child_process';
import { constants as osConstants } from 'node:os';

const SHUTDOWN_GRACE_MS = 2_000;
const FORCE_KILL_GRACE_MS = 1_000;

export const forwardedProcessSignals: readonly NodeJS.Signals[] = process.platform === 'win32'
  ? ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']
  : ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];

type KillProcess = (pid: number, signal: NodeJS.Signals) => boolean;

interface SignalTarget {
  shutdownFromSignal(signal: NodeJS.Signals): Promise<void>;
}

interface ProcessSignalForwarderOptions {
  readonly kill?: KillProcess;
  readonly platform?: NodeJS.Platform;
  readonly processGroup?: boolean;
}

/**
 * Sends lifecycle signals to uv and its Python child without duplicating a
 * Windows console event that the operating system already broadcasts.
 */
export class ProcessSignalForwarder {
  readonly uvPid: number;
  #kill: KillProcess;
  #pending = new Set<NodeJS.Signals>();
  #platform: NodeJS.Platform;
  #processGroup: boolean;
  #pythonPid: number | undefined;

  constructor(uvPid: number, options: ProcessSignalForwarderOptions = {}) {
    this.uvPid = uvPid;
    this.#kill = options.kill ?? process.kill.bind(process);
    this.#platform = options.platform ?? process.platform;
    this.#processGroup = options.processGroup ?? this.#platform !== 'win32';
  }

  get pythonPid(): number | undefined {
    return this.#pythonPid;
  }

  /** Record the real Python PID and replay signals received during startup. */
  setPythonPid(pid: number): void {
    this.#pythonPid = pid;
    for (const signal of this.#pending) {
      this.#send(pid, this.#replaySignal(signal));
    }
    this.#pending.clear();
  }

  /**
   * Forward a signal through the worker tree. `nativeConsoleEvent` means the
   * event came from this process's signal listener rather than `.close()`.
   */
  forward(signal: NodeJS.Signals, nativeConsoleEvent = false): void {
    if (this.#isWindowsConsoleEvent(signal, nativeConsoleEvent)) {
      // Like uv, let Windows deliver Ctrl+C/Break directly to existing
      // console children. Retain it only for Python that appears afterwards.
      if (this.#pythonPid === undefined) this.#pending.add(signal);
      return;
    }

    const sentToUv = this.#send(this.#uvTarget(), signal);
    if (this.#platform === 'win32') {
      if (this.#pythonPid === undefined) this.#pending.add(signal);
      else this.#send(this.#pythonPid, signal);
      return;
    }

    // A detached POSIX uv worker leads a process group containing Python.
    // Fall back to the known Python PID if the group has already disappeared.
    if (!sentToUv && this.#pythonPid !== undefined) this.#send(this.#pythonPid, signal);
    if (this.#pythonPid === undefined) this.#pending.add(signal);
  }

  forceKill(): void {
    const sentToUv = this.#send(this.#uvTarget(), 'SIGKILL');
    if (this.#pythonPid !== undefined && (this.#platform === 'win32' || !sentToUv)) {
      this.#send(this.#pythonPid, 'SIGKILL');
    }
  }

  #isWindowsConsoleEvent(signal: NodeJS.Signals, nativeConsoleEvent: boolean): boolean {
    return this.#platform === 'win32'
      && nativeConsoleEvent
      && (signal === 'SIGINT' || signal === 'SIGBREAK');
  }

  #replaySignal(signal: NodeJS.Signals): NodeJS.Signals {
    // Node cannot reliably generate CTRL_BREAK_EVENT for one process. SIGINT
    // is the closest termination fallback when Python missed the broadcast.
    return this.#platform === 'win32' && signal === 'SIGBREAK' ? 'SIGINT' : signal;
  }

  #send(pid: number, signal: NodeJS.Signals): boolean {
    try {
      return this.#kill(pid, signal);
    } catch {
      return false;
    }
  }

  #uvTarget(): number {
    return this.#processGroup && this.#platform !== 'win32' ? -this.uvPid : this.uvPid;
  }
}

/** Owns a uv process tree and participates in process-level signal handling. */
export class OwnedProcessTree {
  readonly child: ChildProcess;
  readonly exited: Promise<number | null>;
  readonly signals: ProcessSignalForwarder;
  #closing: Promise<void> | undefined;
  #removeSignalTarget: (() => void) | undefined;

  constructor(
    child: ChildProcess,
    pythonPid?: number | Promise<number>,
    options: ProcessSignalForwarderOptions = {},
  ) {
    if (child.pid === undefined) throw new Error('uv worker PID is unavailable.');
    this.child = child;
    this.signals = new ProcessSignalForwarder(child.pid, options);
    this.exited = new Promise(resolve => child.once('close', code => resolve(code)));
    this.#removeSignalTarget = signalCoordinator.add(this);
    child.once('close', () => this.#removeSignalTarget?.());

    if (typeof pythonPid === 'number') this.signals.setPythonPid(pythonPid);
    else if (pythonPid) void pythonPid.then(
      pid => this.signals.setPythonPid(pid),
      () => undefined,
    );
  }

  get pythonPid(): number | undefined {
    return this.signals.pythonPid;
  }

  close(): Promise<void> {
    return this.#shutdown('SIGTERM', false);
  }

  shutdownFromSignal(signal: NodeJS.Signals): Promise<void> {
    return this.#shutdown(signal, true);
  }

  #shutdown(signal: NodeJS.Signals, nativeConsoleEvent: boolean): Promise<void> {
    this.#closing ??= this.#performShutdown(signal, nativeConsoleEvent);
    return this.#closing;
  }

  async #performShutdown(
    signal: NodeJS.Signals,
    nativeConsoleEvent: boolean,
  ): Promise<void> {
    if (hasExited(this.child)) return;
    this.signals.forward(signal, nativeConsoleEvent);
    await Promise.race([this.exited, delay(SHUTDOWN_GRACE_MS)]);
    if (hasExited(this.child)) return;
    this.signals.forceKill();
    await Promise.race([this.exited, delay(FORCE_KILL_GRACE_MS)]);
  }
}

class ProcessSignalCoordinator {
  #handlers = new Map<NodeJS.Signals, () => void>();
  #targets = new Set<SignalTarget>();

  add(target: SignalTarget): () => void {
    this.#targets.add(target);
    if (this.#targets.size === 1) this.#install();
    return () => {
      this.#targets.delete(target);
      if (this.#targets.size === 0) this.#uninstall();
    };
  }

  #install(): void {
    for (const signal of forwardedProcessSignals) {
      const handler = (): void => { this.#handle(signal); };
      this.#handlers.set(signal, handler);
      process.on(signal, handler);
    }
  }

  #uninstall(): void {
    for (const [signal, handler] of this.#handlers) process.off(signal, handler);
    this.#handlers.clear();
  }

  #handle(signal: NodeJS.Signals): void {
    const ownHandler = this.#handlers.get(signal);
    const hasExternalHandler = process.listeners(signal).some(listener => listener !== ownHandler);
    const targets = [...this.#targets];
    this.#uninstall();
    void Promise.allSettled(targets.map(target => target.shutdownFromSignal(signal)))
      .then(() => {
        if (!hasExternalHandler && process.listenerCount(signal) === 0) {
          terminateCurrentProcess(signal);
        }
      });
  }
}

const signalCoordinator = new ProcessSignalCoordinator();

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function terminateCurrentProcess(signal: NodeJS.Signals): void {
  const signalNumber = osConstants.signals[signal] ?? 1;
  process.exitCode = 128 + signalNumber;
  try {
    process.kill(process.pid, signal);
  } catch {
    // Once the owned children are gone, exitCode preserves a useful fallback
    // on runtimes that cannot re-raise a particular emulated Windows signal.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
