import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
} from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import type { ClientOptions, SocketFactory, WebSocketLike } from '@chanx-js/client';
import { pyfig } from 'pyfig';
import { z } from 'zod';
import {
  projectOptionsSchema,
  pynectPythonSchema,
  resolveProject,
} from './config.js';
import { asError } from './errors.js';
import { OwnedProcessTree } from './process-signals.js';
import { withTimeout } from './promise.js';
import {
  createStdioPrefix,
  parseWorkerStdioEvent,
  StdioOutputPump,
  StdioRecordWriter,
  type CloseEvent,
  type OpenEvent,
} from './stdio-protocol.js';

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;
const MAX_STARTUP_DIAGNOSTIC_BYTES = 16 * 1024;

// This launcher intentionally emits hello before importing Pynect or the app.
const STDIO_LAUNCHER = [
  'import json,os,sys',
  "_prefix=os.environ['PYNECT_STDIO_PREFIX'].encode('ascii')",
  "_hello={'type':'hello','protocol':1,'pid':os.getpid()}",
  "_payload=json.dumps(_hello,separators=(',',':')).encode()",
  "sys.stdout.buffer.write(_prefix+str(len(_payload)).encode()+b':'+_payload)",
  'sys.stdout.buffer.flush()',
  'from pynect.worker.stdio import main',
  'main()',
].join(';');

export const workerOptionsSchema = projectOptionsSchema.unwrap().extend({
  python: pynectPythonSchema.prefault({}),
  startupTimeoutMs: z.number().int().positive().default(30_000)
    .describe('Python hello timeout.'),
  shutdownTimeoutMs: z.number().int().positive().default(5_000)
    .describe('Graceful stdio shutdown timeout before process-tree termination.'),
  stdout: z.instanceof(Writable).optional().describe('Destination for ordinary Python stdout.'),
  stderr: z.instanceof(Writable).optional().describe('Destination for Python stderr.'),
}).readonly();

export type StartWorkerOptions = z.input<typeof workerOptionsSchema>;

/** A Python subprocess owned exclusively by the current Bun/Node process. */
export class Worker implements AsyncDisposable {
  readonly child: ChildProcess;
  readonly clientOptions: ClientOptions;
  readonly exited: Promise<number | null>;
  readonly pid: number;
  readonly ready: Promise<void>;
  readonly #controller: WorkerController;
  readonly #shutdownTimeoutMs: number;
  readonly #tree: OwnedProcessTree;
  #closing: Promise<void> | undefined;

  constructor(options: {
    readonly child: ChildProcess;
    readonly controller: WorkerController;
    readonly pid: number;
    readonly shutdownTimeoutMs: number;
    readonly tree: OwnedProcessTree;
  }) {
    this.child = options.child;
    this.#controller = options.controller;
    this.pid = options.pid;
    this.#shutdownTimeoutMs = options.shutdownTimeoutMs;
    this.#tree = options.tree;
    this.exited = options.tree.exited;
    this.ready = options.controller.applicationReady;
    this.clientOptions = Object.freeze({
      baseUrl: 'ws://pynect-stdio',
      reconnectAttempts: 0,
      socketFactory: options.controller.socketFactory,
    });
  }

  /** Wait until the owned Python subprocess terminates. */
  wait(): Promise<number | null> {
    return this.exited;
  }

  /** Close the virtual socket, request shutdown, and terminate on timeout. */
  close(): Promise<void> {
    this.#closing ??= this.#performClose();
    return this.#closing;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  async #performClose(): Promise<void> {
    this.#controller.markClosing();
    try {
      await this.#controller.requestShutdown();
      await withTimeout(
        Promise.all([this.#controller.bye, this.exited]),
        this.#shutdownTimeoutMs,
        'Python stdio worker shutdown',
      );
    } catch (error) {
      await this.#tree.close();
      if (!this.#controller.failed) throw error;
    } finally {
      this.#controller.dispose();
    }
  }
}

/** Start one worker from Pyfig defaults, configured options, or an exact Python path. */
export async function startWorker(input: StartWorkerOptions): Promise<Worker> {
  const parsed = workerOptionsSchema.parse(input);
  const project = resolveProject(parsed);
  const prefix = createStdioPrefix();
  const debug = typeof parsed.python === 'string' ? false : parsed.python.debug;
  const child = await spawnWorker(parsed.python, project.root, {
    PYNECT_APP: project.app,
    PYNECT_LOG_LEVEL: debug ? 'DEBUG' : 'WARNING',
    PYNECT_STDIO_PREFIX: prefix,
    PYTHONUNBUFFERED: '1',
  });
  const controller = new WorkerController(
    child,
    prefix,
    parsed.stdout ?? process.stdout,
    parsed.stderr ?? process.stderr,
  );
  let tree: OwnedProcessTree | undefined;
  try {
    tree = new OwnedProcessTree(child, {
      processGroup: process.platform !== 'win32',
    });
    controller.onFatal = () => { void tree?.close(); };
    const pid = await withTimeout(
      controller.ready,
      parsed.startupTimeoutMs,
      'Python stdio worker hello',
    );
    return new Worker({
      child,
      controller,
      pid,
      shutdownTimeoutMs: parsed.shutdownTimeoutMs,
      tree,
    });
  } catch (cause) {
    await tree?.close();
    controller.dispose();
    throw controller.startupError(cause);
  }
}

async function spawnWorker(
  python: z.output<typeof pynectPythonSchema>,
  root: string,
  workerEnvironment: NodeJS.ProcessEnv,
): Promise<ChildProcessWithoutNullStreams> {
  const spawnOptions: SpawnOptions = {
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  };
  let child: ChildProcess;
  if (typeof python === 'string') {
    const pythonPath = path.resolve(python);
    if (!statSync(pythonPath, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Python executable does not exist: ${pythonPath}`);
    }
    child = spawn(pythonPath, ['-c', STDIO_LAUNCHER], {
      ...spawnOptions,
      cwd: root,
      env: { ...process.env, ...workerEnvironment },
    });
  } else {
    const environment = await pyfig({
      ...python,
      cwd: root,
      env: { ...python.env, ...workerEnvironment },
    });
    child = await environment.python.spawn('-c', STDIO_LAUNCHER, spawnOptions);
  }

  if (!child.stdin || !child.stdout || !child.stderr) {
    child.kill();
    throw new Error('Python stdio worker did not expose piped standard streams.');
  }
  return child as ChildProcessWithoutNullStreams;
}

class WorkerController {
  readonly applicationReady: Promise<void>;
  readonly ready: Promise<number>;
  readonly bye: Promise<void>;
  readonly socketFactory: SocketFactory;
  onFatal: ((error: Error) => void) | undefined;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #writer: StdioRecordWriter;
  readonly #pump: StdioOutputPump;
  readonly #stdout: Writable;
  readonly #stderr: Writable;
  readonly #resolveReady: (pid: number) => void;
  readonly #rejectReady: (error: Error) => void;
  readonly #resolveApplicationReady: () => void;
  readonly #rejectApplicationReady: (error: Error) => void;
  readonly #resolveBye: () => void;
  readonly #rejectBye: (error: Error) => void;
  readonly #onChildError: (error: Error) => void;
  readonly #onChildClose: (code: number | null, signal: NodeJS.Signals | null) => void;
  readonly #onStderrData: (chunk: Buffer | string) => void;
  readonly #onStderrError: (error: Error) => void;
  #active: StdioSocket | undefined;
  #applicationReadySettled = false;
  #byeSettled = false;
  #closing = false;
  #disposed = false;
  #eventCount = 0;
  #failure: Error | undefined;
  #readySettled = false;
  #stderrDiagnostics: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  #stdoutDiagnostics: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  constructor(child: ChildProcessWithoutNullStreams, prefix: string, stdout: Writable, stderr: Writable) {
    this.#child = child;
    this.#stdout = stdout;
    this.#stderr = stderr;
    const ready = Promise.withResolvers<number>();
    const applicationReady = Promise.withResolvers<void>();
    const bye = Promise.withResolvers<void>();
    this.ready = ready.promise;
    this.applicationReady = applicationReady.promise;
    this.bye = bye.promise;
    this.#resolveReady = ready.resolve;
    this.#rejectReady = ready.reject;
    this.#resolveApplicationReady = applicationReady.resolve;
    this.#rejectApplicationReady = applicationReady.reject;
    this.#resolveBye = bye.resolve;
    this.#rejectBye = bye.reject;
    void this.ready.catch(() => undefined);
    void this.applicationReady.catch(() => undefined);
    void this.bye.catch(() => undefined);
    this.#writer = new StdioRecordWriter(child.stdin, prefix);
    this.#pump = new StdioOutputPump({
      input: child.stdout,
      output: stdout,
      prefix,
      onEvent: event => { this.#receive(event); },
      onProtocolError: error => { this.#fail(error); },
      onOutput: output => {
        this.#stdoutDiagnostics = appendDiagnostic(this.#stdoutDiagnostics, output);
      },
      onOutputError: error => {
        this.#fail(new Error('The Python stdout sink failed.', { cause: error }));
      },
      onEnd: () => {
        if (!this.#closing) this.#fail(new Error('Python stdout ended unexpectedly.'));
      },
    });
    this.#onStderrData = chunk => {
      this.#stderrDiagnostics = appendDiagnostic(
        this.#stderrDiagnostics,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      );
    };
    this.#onStderrError = error => {
      this.#fail(new Error('The Python stderr sink failed.', { cause: error }));
    };
    child.stderr.on('data', this.#onStderrData);
    stderr.on('error', this.#onStderrError);
    child.stderr.pipe(stderr, { end: false });
    this.#onChildError = error => { this.#fail(error); };
    this.#onChildClose = (code, signal) => {
      if (!this.#closing || code !== 0) {
        this.#fail(new Error(`Python stdio worker exited with ${signal ?? `code ${code ?? 'unknown'}`}.`));
      }
      this.#active?.finishClose(this.#closing && code === 0 ? 1000 : 1006, 'Python worker exited.');
      this.#active = undefined;
      this.dispose();
    };
    child.once('error', this.#onChildError);
    child.once('close', this.#onChildClose);
    this.socketFactory = (url, protocols, options) => this.#createSocket(
      url,
      protocols,
      options?.headers,
    );
  }

  get failed(): boolean {
    return this.#failure !== undefined;
  }

  markClosing(): void {
    this.#closing = true;
  }

  async requestShutdown(): Promise<void> {
    if (this.#failure) throw this.#failure;
    await this.#active?.requestClose(1000, '');
    await this.#writer.write({ type: 'shutdown' });
    await this.#writer.end();
  }

  startupError(cause: unknown): Error {
    const error = asError(cause);
    const diagnostics = [
      diagnostic('stdout', this.#stdoutDiagnostics),
      diagnostic('stderr', this.#stderrDiagnostics),
    ].filter((value): value is string => value !== undefined);
    if (diagnostics.length === 0) return error;
    return new Error(`${error.message}\n${diagnostics.join('\n')}`, { cause: error });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#pump[Symbol.dispose]();
    this.#child.off('error', this.#onChildError);
    this.#child.off('close', this.#onChildClose);
    this.#child.stderr.off('data', this.#onStderrData);
    this.#child.stderr.unpipe(this.#stderr);
    this.#stderr.off('error', this.#onStderrError);
  }

  closeSocket(socket: StdioSocket, event: CloseEvent): Promise<void> {
    if (socket !== this.#active) return Promise.resolve();
    return this.#writer.write(event).catch(error => {
      this.#fail(asError(error));
      throw error;
    });
  }

  sendFrame(socket: StdioSocket, data: string): void {
    if (socket !== this.#active) throw new Error('Pynect stdio socket is not active.');
    void this.#writer.write({ type: 'frame', data }).catch(error => { this.#fail(asError(error)); });
  }

  #createSocket(
    url: string,
    protocols?: string | string[],
    headers?: Record<string, string>,
  ): StdioSocket {
    if (this.#failure) throw this.#failure;
    if (this.#active && this.#active.readyState < CLOSED) {
      throw new Error('Pynect stdio supports one virtual WebSocket at a time.');
    }
    const parsed = new URL(url);
    const event: OpenEvent = {
      type: 'open',
      path: parsed.pathname,
      query: parsed.search.slice(1),
      headers: headers ?? {},
      subprotocols: typeof protocols === 'string' ? [protocols] : (protocols ?? []),
    };
    const socket = new StdioSocket(this);
    this.#active = socket;
    void this.#writer.write(event).then(
      () => { socket.finishOpen(); },
      error => { this.#fail(asError(error)); },
    );
    return socket;
  }

  #receive(value: unknown): void {
    try {
      const event = parseWorkerStdioEvent(value);
      this.#eventCount += 1;
      if (this.#eventCount === 1) {
        if (event.type !== 'hello') {
          throw new Error('The first Python stdio event was not hello.');
        }
        this.#readySettled = true;
        this.#resolveReady(event.pid);
        return;
      }
      if (event.type === 'hello') throw new Error('Python emitted duplicate stdio hello events.');
      if (event.type === 'ready') {
        if (this.#applicationReadySettled) {
          throw new Error('Python emitted duplicate stdio ready events.');
        }
        this.#applicationReadySettled = true;
        this.#resolveApplicationReady();
      } else if (event.type === 'frame') {
        if (!this.#active) throw new Error('Python emitted a frame without an open connection.');
        this.#active.receive(event.data);
      } else if (event.type === 'close') {
        this.#active?.finishClose(event.code, event.reason);
        this.#active = undefined;
      } else if (event.type === 'error') {
        throw new Error(`Python stdio worker failed: ${event.message}`);
      } else if (event.type === 'bye') {
        if (this.#byeSettled) throw new Error('Python emitted duplicate stdio bye events.');
        this.#byeSettled = true;
        this.#resolveBye();
      }
    } catch (error) {
      this.#fail(asError(error));
    }
  }

  #fail(error: Error): void {
    if (this.#failure) {
      this.#failure = new AggregateError([this.#failure, error], 'Multiple stdio worker failures occurred.');
      return;
    }
    this.#failure = error;
    if (!this.#readySettled) {
      this.#readySettled = true;
      this.#rejectReady(error);
    }
    if (!this.#applicationReadySettled) {
      this.#applicationReadySettled = true;
      this.#rejectApplicationReady(error);
    }
    if (!this.#byeSettled) {
      this.#byeSettled = true;
      this.#rejectBye(error);
    }
    this.#active?.fail(error);
    this.#active = undefined;
    this.onFatal?.(error);
  }
}

class StdioSocket implements WebSocketLike {
  readyState = CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly #controller: WorkerController;
  #closeRequest: Promise<void> | undefined;

  constructor(controller: WorkerController) {
    this.#controller = controller;
  }

  send(data: string): void {
    if (this.readyState !== OPEN) throw new Error('Pynect stdio socket is not open.');
    if (typeof data !== 'string') throw new TypeError('Pynect stdio accepts text frames only.');
    this.#controller.sendFrame(this, data);
  }

  close(code = 1000, reason = ''): void {
    void this.requestClose(code, reason).catch(error => { this.fail(asError(error)); });
  }

  requestClose(code: number, reason: string): Promise<void> {
    if (this.readyState === CLOSED) return Promise.resolve();
    if (this.#closeRequest) return this.#closeRequest;
    this.readyState = CLOSING;
    this.#closeRequest = this.#controller.closeSocket(this, { type: 'close', code, reason });
    return this.#closeRequest;
  }

  finishOpen(): void {
    if (this.readyState !== CONNECTING) return;
    this.readyState = OPEN;
    this.onopen?.({});
  }

  receive(data: string): void {
    if (this.readyState === OPEN) this.onmessage?.({ data });
  }

  finishClose(code: number, reason: string): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.onclose?.({ code, reason });
  }

  fail(error: Error): void {
    if (this.readyState === CLOSED) return;
    this.onerror?.(error);
    this.finishClose(1006, error.message);
  }
}

function appendDiagnostic(
  current: Buffer<ArrayBufferLike>,
  chunk: Buffer<ArrayBufferLike>,
): Buffer<ArrayBufferLike> {
  const combined = current.length === 0 ? chunk : Buffer.concat([current, chunk]);
  return combined.length <= MAX_STARTUP_DIAGNOSTIC_BYTES
    ? combined
    : combined.subarray(combined.length - MAX_STARTUP_DIAGNOSTIC_BYTES);
}

function diagnostic(name: string, value: Buffer<ArrayBufferLike>): string | undefined {
  const text = value.toString('utf8').trimEnd();
  return text ? `Python ${name}:\n${text}` : undefined;
}
