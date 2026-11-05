import { randomBytes } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';

export const STDIO_PROTOCOL_VERSION = 1;
export const MAX_STDIO_RECORD_BYTES = 16 * 1024 * 1024;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export interface HelloEvent {
  readonly type: 'hello';
  readonly protocol: typeof STDIO_PROTOCOL_VERSION;
  readonly pid: number;
}

export interface OpenEvent {
  readonly type: 'open';
  readonly path: string;
  readonly query: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly subprotocols: readonly string[];
}

export interface FrameEvent {
  readonly type: 'frame';
  readonly data: string;
}

export interface CloseEvent {
  readonly type: 'close';
  readonly code: number;
  readonly reason: string;
}

export interface ErrorEvent {
  readonly type: 'error';
  readonly message: string;
}

export interface ShutdownEvent {
  readonly type: 'shutdown';
}

export interface ByeEvent {
  readonly type: 'bye';
}

export type ParentStdioEvent = OpenEvent | FrameEvent | CloseEvent | ShutdownEvent;
export type WorkerStdioEvent = HelloEvent | FrameEvent | CloseEvent | ErrorEvent | ByeEvent;

/** Create the per-process marker that separates protocol records from Python output. */
export function createStdioPrefix(): string {
  return `@pynect:${randomBytes(12).toString('base64url')} `;
}

/** Serialize one marker, decimal byte length, separator, and compact JSON payload. */
export function encodeStdioRecord(
  prefix: string,
  event: ParentStdioEvent | WorkerStdioEvent,
): Buffer {
  const payload = Buffer.from(JSON.stringify(event));
  if (payload.length > MAX_STDIO_RECORD_BYTES) {
    throw new Error(`Pynect stdio record exceeds ${MAX_STDIO_RECORD_BYTES} bytes.`);
  }
  return Buffer.concat([Buffer.from(`${prefix}${payload.length}:`), payload]);
}

/** Validate an event received from the Python worker. */
export function parseWorkerStdioEvent(value: unknown): WorkerStdioEvent {
  const event = record(value);
  switch (event.type) {
    case 'hello': {
      const protocol = integer(event.protocol, 'hello.protocol');
      if (protocol !== STDIO_PROTOCOL_VERSION) {
        throw new Error(`Unsupported Pynect stdio protocol version ${protocol}.`);
      }
      const pid = integer(event.pid, 'hello.pid');
      if (pid <= 0) throw new Error('Pynect stdio hello.pid must be positive.');
      return { type: 'hello', protocol: STDIO_PROTOCOL_VERSION, pid };
    }
    case 'frame':
      return { type: 'frame', data: stringValue(event.data, 'frame.data') };
    case 'close':
      return closeEvent(event);
    case 'error':
      return { type: 'error', message: stringValue(event.message, 'error.message') };
    case 'bye':
      return { type: 'bye' };
    default:
      throw new Error(`Unknown Pynect stdio event type ${JSON.stringify(event.type)}.`);
  }
}

/** Separate length-prefixed records from byte-exact ordinary stdout at any offset. */
export class StdioOutputParser {
  readonly #prefix: Buffer;
  readonly #onEvent: (event: unknown) => void;
  readonly #onOutput: (output: Buffer) => void;
  readonly #onProtocolError: (error: Error) => void;
  #buffer: Buffer = Buffer.alloc(0);
  #finished = false;
  #failed = false;

  constructor(options: {
    readonly prefix: string;
    readonly onEvent: (event: unknown) => void;
    readonly onOutput: (output: Buffer) => void;
    readonly onProtocolError: (error: Error) => void;
  }) {
    this.#prefix = Buffer.from(options.prefix);
    this.#onEvent = options.onEvent;
    this.#onOutput = options.onOutput;
    this.#onProtocolError = options.onProtocolError;
  }

  push(chunk: Buffer | string): void {
    if (this.#finished || this.#failed) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.#buffer = this.#buffer.length === 0 ? bytes : Buffer.concat([this.#buffer, bytes]);
    this.#drain();
  }

  finish(): void {
    if (this.#finished || this.#failed) return;
    this.#finished = true;
    if (this.#buffer.length === 0) return;
    if (this.#isPrefixFragment(this.#buffer)) {
      this.#protocolError(new Error('Python stdout ended during a Pynect protocol record.'));
    } else {
      this.#onOutput(this.#buffer);
    }
    this.#buffer = Buffer.alloc(0);
  }

  #drain(): void {
    while (this.#buffer.length > 0 && !this.#failed) {
      const marker = this.#buffer.indexOf(this.#prefix);
      if (marker < 0) {
        const retained = matchingPrefixSuffix(this.#buffer, this.#prefix);
        const outputLength = this.#buffer.length - retained;
        if (outputLength > 0) this.#onOutput(this.#buffer.subarray(0, outputLength));
        this.#buffer = this.#buffer.subarray(outputLength);
        return;
      }
      if (marker > 0) {
        this.#onOutput(this.#buffer.subarray(0, marker));
        this.#buffer = this.#buffer.subarray(marker);
      }

      const lengthStart = this.#prefix.length;
      const separator = this.#buffer.indexOf(0x3a, lengthStart);
      if (separator < 0) {
        const digits = this.#buffer.subarray(lengthStart);
        if (digits.length > 10 || [...digits].some(byte => byte < 0x30 || byte > 0x39)) {
          this.#protocolError(new Error('Python emitted an invalid Pynect record length.'));
        }
        return;
      }
      const digits = this.#buffer.subarray(lengthStart, separator);
      if (
        digits.length === 0
        || digits.length > 10
        || [...digits].some(byte => byte < 0x30 || byte > 0x39)
      ) {
        this.#protocolError(new Error('Python emitted an invalid Pynect record length.'));
        return;
      }
      const length = Number(digits.toString('ascii'));
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_STDIO_RECORD_BYTES) {
        this.#protocolError(new Error(`Python emitted an out-of-range Pynect record length ${length}.`));
        return;
      }
      const payloadStart = separator + 1;
      const recordEnd = payloadStart + length;
      if (this.#buffer.length < recordEnd) return;
      const payload = this.#buffer.subarray(payloadStart, recordEnd);
      this.#buffer = this.#buffer.subarray(recordEnd);
      try {
        this.#onEvent(JSON.parse(utf8Decoder.decode(payload)) as unknown);
      } catch (cause) {
        this.#protocolError(new Error('Python emitted malformed Pynect stdio JSON.', { cause }));
      }
    }
  }

  #isPrefixFragment(value: Buffer): boolean {
    const compared = Math.min(value.length, this.#prefix.length);
    return value.subarray(0, compared).equals(this.#prefix.subarray(0, compared));
  }

  #protocolError(error: Error): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#onProtocolError(error);
  }
}

/** Attach an output parser while honoring backpressure from the pass-through sink. */
export class StdioOutputPump implements Disposable {
  readonly #input: Readable;
  readonly #output: Writable;
  readonly #parser: StdioOutputParser;
  readonly #onData: (chunk: Buffer | string) => void;
  readonly #onDrain: () => void;
  readonly #onEnd: () => void;
  readonly #onInputError: (error: Error) => void;
  readonly #onOutputError: (error: Error) => void;
  #disposed = false;
  #outputFailed = false;

  constructor(options: {
    readonly input: Readable;
    readonly output: Writable;
    readonly prefix: string;
    readonly onEvent: (event: unknown) => void;
    readonly onProtocolError: (error: Error) => void;
    readonly onOutput?: (output: Buffer) => void;
    readonly onOutputError: (error: Error) => void;
    readonly onEnd?: () => void;
  }) {
    this.#input = options.input;
    this.#output = options.output;
    this.#parser = new StdioOutputParser({
      prefix: options.prefix,
      onEvent: options.onEvent,
      onProtocolError: options.onProtocolError,
      onOutput: output => {
        options.onOutput?.(output);
        if (this.#outputFailed) return;
        try {
          if (!this.#output.write(output)) this.#input.pause();
        } catch (cause) {
          this.#handleOutputError(asError(cause));
        }
      },
    });
    this.#onData = chunk => { this.#parser.push(chunk); };
    this.#onDrain = () => { if (!this.#disposed) this.#input.resume(); };
    this.#onEnd = () => {
      this.#parser.finish();
      options.onEnd?.();
    };
    this.#onInputError = error => { options.onProtocolError(error); };
    this.#onOutputError = error => { this.#handleOutputError(error); };
    this.#input.on('data', this.#onData);
    this.#input.once('end', this.#onEnd);
    this.#input.once('error', this.#onInputError);
    this.#output.on('drain', this.#onDrain);
    this.#output.on('error', this.#onOutputError);
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#input.off('data', this.#onData);
    this.#input.off('end', this.#onEnd);
    this.#input.off('error', this.#onInputError);
    this.#output.off('drain', this.#onDrain);
    this.#output.off('error', this.#onOutputError);
  }

  #handleOutputError(error: Error): void {
    if (this.#outputFailed) return;
    this.#outputFailed = true;
    this.#onOutputError(error);
  }
}

/** Serialize complete stdin records and wait for each write callback in order. */
export class StdioRecordWriter {
  readonly #output: Writable;
  readonly #prefix: string;
  #tail = Promise.resolve();
  #ended = false;

  constructor(output: Writable, prefix: string) {
    this.#output = output;
    this.#prefix = prefix;
  }

  write(event: ParentStdioEvent): Promise<void> {
    if (this.#ended) return Promise.reject(new Error('Python stdio stdin is closed.'));
    const operation = this.#tail.then(() => writeChunk(
      this.#output,
      encodeStdioRecord(this.#prefix, event),
    ));
    this.#tail = operation.catch(() => undefined);
    return operation;
  }

  async end(): Promise<void> {
    if (this.#ended) return this.#tail;
    this.#ended = true;
    await this.#tail;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.#output.off('error', onError);
        reject(error);
      };
      this.#output.once('error', onError);
      this.#output.end(() => {
        this.#output.off('error', onError);
        resolve();
      });
    });
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Pynect stdio events must be JSON objects.');
  }
  return value as Record<string, unknown>;
}

function closeEvent(event: Record<string, unknown>): CloseEvent {
  const code = integer(event.code, 'close.code');
  if (code < 0 || code > 4_999) throw new Error('Pynect stdio close.code is out of range.');
  return { type: 'close', code, reason: stringValue(event.reason, 'close.reason') };
}

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`Pynect stdio ${field} must be an integer.`);
  return value as number;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`Pynect stdio ${field} must be a string.`);
  return value;
}

function writeChunk(output: Writable, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    output.write(chunk, error => { if (error) reject(error); else resolve(); });
  });
}

function matchingPrefixSuffix(value: Buffer, prefix: Buffer): number {
  const maximum = Math.min(value.length, prefix.length - 1);
  for (let length = maximum; length > 0; length -= 1) {
    if (value.subarray(value.length - length).equals(prefix.subarray(0, length))) return length;
  }
  return 0;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
