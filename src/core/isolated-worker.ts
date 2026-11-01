import type { ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface, type Interface as ReadlineInterface } from 'readline';
import { createPynectPyfig } from '../env/pyfig-adapter';

export interface IsolatedCallOptions {
  kwargs?: Record<string, unknown>;
  timeout?: number;
  signal?: AbortSignal;
}

interface IsolatedWorkerOptions {
  pythonExecutable: string;
  projectRoot: string;
  scriptPath: string;
  cwd: string;
  timeout: number;
  env: Record<string, string>;
  pythonPath: string[];
  dispatcher: object;
  includeTracebacks: boolean;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** Persistent JSON-only child process used when hard termination is required. */
export class IsolatedWorker {
  private child?: ChildProcessWithoutNullStreams;
  private lines?: ReadlineInterface;
  private nextId = 0;
  private readonly pending = new Map<number, PendingCall>();
  private closing = false;
  private stderrTail = '';

  constructor(private readonly options: IsolatedWorkerOptions) {}

  async call<T = unknown>(
    moduleName: string,
    functionName: string,
    args: unknown[] = [],
    callOptions: IsolatedCallOptions = {},
  ): Promise<T> {
    if (callOptions.signal?.aborted) throw this.abortError();
    const child = await this.ensureStarted();
    const id = ++this.nextId;
    const timeout = callOptions.timeout ?? this.options.timeout;
    return new Promise<T>((resolve, reject) => {
      const pending: PendingCall = {
        resolve: value => resolve(value as T),
        reject,
        signal: callOptions.signal,
      };
      if (timeout > 0) {
        pending.timer = setTimeout(() => {
          this.terminate(new Error(`Isolated Python call exceeded ${timeout}ms`));
        }, timeout);
      }
      if (callOptions.signal) {
        pending.onAbort = () => this.terminate(this.abortError());
        callOptions.signal.addEventListener('abort', pending.onAbort, { once: true });
      }
      this.pending.set(id, pending);
      this.setReferenced(true);
      const request = {
        id,
        module: moduleName,
        function: functionName,
        args,
        kwargs: callOptions.kwargs ?? {},
        executionTimeout: timeout,
      };
      child.stdin.write(`${JSON.stringify(request)}\n`, error => {
        if (error) this.terminate(error);
      });
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    this.terminate(new Error('Isolated Python worker closed'));
  }

  closeSync(): void {
    this.closing = true;
    this.terminate(new Error('Isolated Python worker closed'));
  }

  private async ensureStarted(): Promise<ChildProcessWithoutNullStreams> {
    if (this.child && !this.child.killed) return this.child;
    this.closing = false;
    this.stderrTail = '';
    const pythonPath = [
      ...this.options.pythonPath,
      process.env['PYTHONPATH'],
    ].filter(Boolean).join(process.platform === 'win32' ? ';' : ':');
    const client = createPynectPyfig({
      projectRoot: this.options.projectRoot,
      pythonPath: this.options.pythonExecutable,
      env: this.options.env,
    });
    const child = await client.python([this.options.scriptPath], {
      cwd: this.options.cwd,
      env: {
        ...process.env,
        ...this.options.env,
        PYTHONPATH: pythonPath,
        PYNECT_DISPATCHER_CONFIG: JSON.stringify(this.options.dispatcher),
        PYNECT_INCLUDE_TRACEBACKS: this.options.includeTracebacks ? '1' : '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on('line', line => this.handleLine(line));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-4000);
    });
    child.on('error', error => this.terminate(error));
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.lines?.close();
      this.lines = undefined;
      if (!this.closing && this.pending.size) {
        const detail = this.stderrTail.trim();
        this.rejectAll(new Error(
          `Isolated Python worker exited (${signal ?? code ?? 'unknown'})${detail ? `: ${detail}` : ''}`,
        ));
      }
    });
    this.setReferenced(false);
    return child;
  }

  private handleLine(line: string): void {
    let message: {
      id?: number;
      ok?: boolean;
      result?: unknown;
      error?: { type?: string; message?: string; traceback?: string };
    };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      this.terminate(new Error('Isolated Python worker returned invalid JSON'));
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    this.cleanupPending(pending);
    if (!this.pending.size) this.setReferenced(false);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    const error = new Error(message.error?.message ?? 'Isolated Python call failed');
    error.name = message.error?.type ?? 'PythonError';
    if (message.error?.traceback) error.stack = message.error.traceback;
    pending.reject(error);
  }

  private terminate(error: Error): void {
    const child = this.child;
    this.child = undefined;
    this.lines?.close();
    this.lines = undefined;
    if (child && !child.killed) child.kill();
    this.rejectAll(error);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      this.cleanupPending(pending);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private setReferenced(referenced: boolean): void {
    if (!this.child) return;
    const method = referenced ? 'ref' : 'unref';
    this.child[method]();
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
      (stream as unknown as { ref?: () => void; unref?: () => void })[method]?.();
    }
  }

  private cleanupPending(pending: PendingCall): void {
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener('abort', pending.onAbort);
    }
  }

  private abortError(): Error {
    const error = new Error('Isolated Python call was aborted');
    error.name = 'AbortError';
    return error;
  }
}
