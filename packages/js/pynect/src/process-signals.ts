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

/** Signal the one directly owned worker, or its isolated POSIX process group. */
export class ProcessSignalForwarder {
  readonly pid: number;
  readonly #kill: KillProcess;
  readonly #platform: NodeJS.Platform;
  readonly #processGroup: boolean;

  constructor(pid: number, options: ProcessSignalForwarderOptions = {}) {
    this.pid = pid;
    this.#kill = options.kill ?? process.kill.bind(process);
    this.#platform = options.platform ?? process.platform;
    this.#processGroup = options.processGroup ?? this.#platform !== 'win32';
  }

  /** Forward a shutdown signal unless Windows already broadcast the console event. */
  forward(signal: NodeJS.Signals, nativeConsoleEvent = false): void {
    if (
      this.#platform === 'win32'
      && nativeConsoleEvent
      && (signal === 'SIGINT' || signal === 'SIGBREAK')
    ) return;
    this.#send(this.#target(), signal);
  }

  forceKill(): void {
    this.#send(this.#target(), 'SIGKILL');
  }

  #send(pid: number, signal: NodeJS.Signals): boolean {
    try {
      return this.#kill(pid, signal);
    } catch {
      return false;
    }
  }

  #target(): number {
    return this.#processGroup && this.#platform !== 'win32' ? -this.pid : this.pid;
  }
}

/** Own one child process and participate in process-level signal handling. */
export class OwnedProcessTree {
  readonly child: ChildProcess;
  readonly exited: Promise<number | null>;
  readonly signals: ProcessSignalForwarder;
  #closing: Promise<void> | undefined;
  #removeSignalTarget: (() => void) | undefined;

  constructor(child: ChildProcess, options: ProcessSignalForwarderOptions = {}) {
    if (child.pid === undefined) throw new Error('Owned worker PID is unavailable.');
    this.child = child;
    this.signals = new ProcessSignalForwarder(child.pid, options);
    this.exited = new Promise(resolve => child.once('close', code => resolve(code)));
    this.#removeSignalTarget = signalCoordinator.add(this);
    child.once('close', () => this.#removeSignalTarget?.());
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

  async #performShutdown(signal: NodeJS.Signals, nativeConsoleEvent: boolean): Promise<void> {
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
        if (!hasExternalHandler && process.listenerCount(signal) === 0) terminateCurrentProcess(signal);
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
    // exitCode preserves a useful fallback when the runtime cannot re-raise a signal.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
