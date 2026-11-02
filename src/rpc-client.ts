import { decode, encode } from '@msgpack/msgpack';
import type { Socket } from 'node:net';
import { PythonError, VenvClosedError, type RemotePythonError } from './errors';
import { createPythonObject, getPythonReference } from './python-object';

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 256 * 1024 * 1024;
const WIRE_TYPE = '__pynect_wire_type__';

interface PendingRequest {
  readonly reject: (error: unknown) => void;
  readonly resolve: (value: unknown) => void;
  readonly timer?: NodeJS.Timeout;
}

interface FinalizedReference {
  readonly client: WeakRef<RpcClient>;
  readonly id: number;
}

type JavaScriptCallback = (...args: any[]) => unknown;

const referenceFinalizer = new FinalizationRegistry<FinalizedReference>(({ client, id }) => {
  client.deref()?.notify('release', { target: id });
});

export class RpcClient {
  readonly #socket: Socket;
  readonly #token: string;
  readonly #callTimeoutMs: number;
  readonly #autoUnref: boolean;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #callbacks = new Map<number, JavaScriptCallback>();
  readonly #callbackIds = new WeakMap<JavaScriptCallback, number>();
  #nextRequestId = 1;
  #nextCallbackId = 1;
  #buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  #closed = false;
  #helloSettled = false;
  readonly #hello: Promise<void>;
  #resolveHello!: () => void;
  #rejectHello!: (error: unknown) => void;

  private constructor(
    socket: Socket,
    token: string,
    callTimeoutMs: number,
    autoUnref: boolean,
  ) {
    this.#socket = socket;
    this.#token = token;
    this.#callTimeoutMs = callTimeoutMs;
    this.#autoUnref = autoUnref;
    this.#hello = new Promise<void>((resolve, reject) => {
      this.#resolveHello = resolve;
      this.#rejectHello = reject;
    });
    socket.on('data', data => this.#receive(data));
    socket.once('error', error => this.#fail(error));
    socket.once('close', () => this.#fail(new VenvClosedError('Python worker disconnected.')));
  }

  static async connect(options: {
    readonly autoUnref: boolean;
    readonly callTimeoutMs: number;
    readonly socket: Socket;
    readonly timeoutMs: number;
    readonly token: string;
  }): Promise<RpcClient> {
    const client = new RpcClient(
      options.socket,
      options.token,
      options.callTimeoutMs,
      options.autoUnref,
    );
    await withTimeout(client.#hello, options.timeoutMs, 'Python worker handshake timed out.');
    if (options.autoUnref) options.socket.unref();
    return client;
  }

  get closed(): boolean {
    return this.#closed;
  }

  request(operation: string, payload: Readonly<Record<string, unknown>> = {}): Promise<unknown> {
    if (this.#closed) return Promise.reject(new VenvClosedError());
    const id = this.#nextRequestId++;
    if (this.#autoUnref) this.#socket.ref();
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = this.#callTimeoutMs > 0
        ? setTimeout(() => {
          this.#pending.delete(id);
          reject(new Error(`Python call timed out after ${this.#callTimeoutMs}ms.`));
          this.#unrefWhenIdle();
        }, this.#callTimeoutMs)
        : undefined;
      timer?.unref();
      this.#pending.set(id, { reject, resolve, timer });
    });
    void this.#send({
      id,
      kind: 'request',
      op: operation,
      payload: this.#encodeValue(payload),
    }).catch(error => this.#rejectPending(id, error));
    return promise.finally(() => this.#unrefWhenIdle());
  }

  notify(operation: string, payload: Readonly<Record<string, unknown>> = {}): void {
    if (this.#closed) return;
    void this.#send({
      kind: 'notify',
      op: operation,
      payload: this.#encodeValue(payload),
    }).catch(() => undefined);
  }

  release(id: number): Promise<void> {
    return this.request('release', { target: id }).then(() => undefined);
  }

  trackReference(value: object, id: number): void {
    referenceFinalizer.register(value, { client: new WeakRef(this), id });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    try {
      await withTimeout(this.request('shutdown'), 2_000, 'Python worker shutdown timed out.');
    } catch {
      // The owning Venv terminates an unresponsive child after this transport closes.
    }
    this.#closed = true;
    this.#socket.end();
    this.#socket.destroy();
    this.#callbacks.clear();
    this.#fail(new VenvClosedError());
  }

  forceClose(error = new VenvClosedError()): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.destroy();
    this.#fail(error);
  }

  #receive(data: Buffer): void {
    this.#buffer = this.#buffer.length === 0 ? data : Buffer.concat([this.#buffer, data]);
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) {
        this.#fail(new Error(`Python worker sent an oversized ${length}-byte frame.`));
        return;
      }
      if (this.#buffer.length < length + 4) return;
      const payload = this.#buffer.subarray(4, length + 4);
      this.#buffer = this.#buffer.subarray(length + 4);
      try {
        this.#handleMessage(decode(payload, { useBigInt64: true }));
      } catch (error) {
        this.#fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
  }

  #handleMessage(value: unknown): void {
    if (!isRecord(value) || typeof value['kind'] !== 'string') {
      throw new TypeError('Python worker sent an invalid message.');
    }
    switch (value['kind']) {
      case 'hello':
        this.#handleHello(value);
        return;
      case 'response':
        this.#handleResponse(value);
        return;
      case 'callback':
        void this.#handleCallback(value);
        return;
      default:
        throw new TypeError(`Python worker sent an unknown message kind: ${value['kind']}`);
    }
  }

  #handleHello(message: Record<string, unknown>): void {
    if (this.#helloSettled) throw new Error('Python worker sent more than one handshake.');
    this.#helloSettled = true;
    if (message['protocol'] !== PROTOCOL_VERSION || message['token'] !== this.#token) {
      const error = new Error('Python worker handshake validation failed.');
      this.#rejectHello(error);
      this.#fail(error);
      return;
    }
    this.#resolveHello();
  }

  #handleResponse(message: Record<string, unknown>): void {
    const id = message['id'];
    if (typeof id !== 'number') throw new TypeError('Python response has no numeric id.');
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if (message['ok'] === true) {
      pending.resolve(this.#decodeValue(message['value']));
      return;
    }
    pending.reject(new PythonError(normalizeRemoteError(message['error'])));
  }

  async #handleCallback(message: Record<string, unknown>): Promise<void> {
    const requestId = message['id'];
    const callbackId = message['callback'];
    if (typeof requestId !== 'number' || typeof callbackId !== 'number') {
      throw new TypeError('Python callback request is malformed.');
    }
    const callback = this.#callbacks.get(callbackId);
    this.#socket.ref();
    try {
      if (!callback) throw new Error(`JavaScript callback ${callbackId} is unavailable.`);
      const argsValue = this.#decodeValue(message['args']);
      const kwargsValue = this.#decodeValue(message['kwargs']);
      const args = Array.isArray(argsValue) ? argsValue : [];
      if (isRecord(kwargsValue) && Object.keys(kwargsValue).length > 0) args.push(kwargsValue);
      const result = await callback(...args);
      await this.#send({
        id: requestId,
        kind: 'callback_result',
        ok: true,
        value: this.#encodeValue(result),
      });
    } catch (error) {
      await this.#send({
        error: serializeJavaScriptError(error),
        id: requestId,
        kind: 'callback_result',
        ok: false,
      }).catch(() => undefined);
    } finally {
      this.#unrefWhenIdle();
    }
  }

  #encodeValue(value: unknown, seen = new Set<object>()): unknown {
    if (
      value === null || typeof value === 'string' || typeof value === 'boolean' ||
      typeof value === 'number' || typeof value === 'bigint'
    ) return value;
    if (value === undefined) return { [WIRE_TYPE]: 'undefined' };

    const reference = getPythonReference(value);
    if (reference) {
      if (reference.client !== this) {
        throw new TypeError('A Python object cannot cross between different Venv instances.');
      }
      if (reference.path.length > 0) {
        throw new TypeError('Await a Python attribute before passing it back to Python.');
      }
      return { [WIRE_TYPE]: 'reference', id: reference.id };
    }

    if (typeof value === 'function') {
      const callback = value as JavaScriptCallback;
      let id = this.#callbackIds.get(callback);
      if (id === undefined) {
        id = this.#nextCallbackId++;
        this.#callbackIds.set(callback, id);
        this.#callbacks.set(id, callback);
      }
      return { [WIRE_TYPE]: 'callback', id };
    }
    if (typeof value !== 'object') {
      throw new TypeError(`Cannot pass ${typeof value} values to Python.`);
    }
    if (seen.has(value)) throw new TypeError('Cannot pass circular JavaScript values to Python.');
    seen.add(value);
    try {
      if (value instanceof Date) return { [WIRE_TYPE]: 'datetime', value: value.toISOString() };
      if (value instanceof Uint8Array) return value;
      if (Array.isArray(value)) return value.map(item => this.#encodeValue(item, seen));
      if (value instanceof Set) {
        return { [WIRE_TYPE]: 'set', value: [...value].map(item => this.#encodeValue(item, seen)) };
      }
      if (value instanceof Map) {
        return {
          [WIRE_TYPE]: 'map',
          value: [...value].map(([key, item]) => [
            this.#encodeValue(key, seen),
            this.#encodeValue(item, seen),
          ]),
        };
      }
      const record = value as Record<string, unknown>;
      if (WIRE_TYPE in record) {
        return {
          [WIRE_TYPE]: 'map',
          value: Object.entries(record).map(([key, item]) => [key, this.#encodeValue(item, seen)]),
        };
      }
      return Object.fromEntries(
        Object.entries(record).map(([key, item]) => [key, this.#encodeValue(item, seen)]),
      );
    } finally {
      seen.delete(value);
    }
  }

  #decodeValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(item => this.#decodeValue(item));
    if (!isRecord(value)) return value;
    const type = value[WIRE_TYPE];
    switch (type) {
      case 'reference': {
        const id = value['id'];
        if (typeof id !== 'number') throw new TypeError('Python reference has no numeric id.');
        return createPythonObject(
          this,
          id,
          typeof value['pythonType'] === 'string' ? value['pythonType'] : undefined,
        );
      }
      case 'undefined': return undefined;
      case 'datetime':
      case 'date': {
        const date = new Date(String(value['value']));
        return Number.isNaN(date.valueOf()) ? String(value['value']) : date;
      }
      case 'time': return String(value['value']);
      case 'set': {
        const items = value['value'];
        return new Set(Array.isArray(items) ? items.map(item => this.#decodeValue(item)) : []);
      }
      case 'map': {
        const entries = value['value'];
        if (!Array.isArray(entries)) return new Map();
        return new Map(entries.map(entry => {
          if (!Array.isArray(entry) || entry.length !== 2) return [undefined, undefined];
          return [this.#decodeValue(entry[0]), this.#decodeValue(entry[1])];
        }));
      }
      default:
        return Object.fromEntries(
          Object.entries(value).map(([key, item]) => [key, this.#decodeValue(item)]),
        );
    }
  }

  async #send(message: Readonly<Record<string, unknown>>): Promise<void> {
    if (this.#closed) throw new VenvClosedError();
    const payload = Buffer.from(encode(message, { useBigInt64: true }));
    if (payload.length > MAX_FRAME_BYTES) {
      throw new RangeError(`RPC frame exceeds ${MAX_FRAME_BYTES} bytes.`);
    }
    const frame = Buffer.allocUnsafe(payload.length + 4);
    frame.writeUInt32BE(payload.length, 0);
    payload.copy(frame, 4);
    await new Promise<void>((resolve, reject) => {
      this.#socket.write(frame, error => error ? reject(error) : resolve());
    });
  }

  #rejectPending(id: number, error: unknown): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    pending.reject(error);
    this.#unrefWhenIdle();
  }

  #fail(error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error));
    this.#closed = true;
    if (!this.#helloSettled) {
      this.#helloSettled = true;
      this.#rejectHello(failure);
    }
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(failure);
    }
  }

  #unrefWhenIdle(): void {
    if (this.#autoUnref && this.#pending.size === 0 && !this.#closed) this.#socket.unref();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeRemoteError(value: unknown): RemotePythonError {
  if (!isRecord(value)) return { message: String(value), type: 'Exception' };
  return {
    message: typeof value['message'] === 'string' ? value['message'] : 'Python call failed.',
    traceback: typeof value['traceback'] === 'string' ? value['traceback'] : undefined,
    type: typeof value['type'] === 'string' ? value['type'] : 'Exception',
  };
}

function serializeJavaScriptError(error: unknown): Record<string, string> {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack ?? '', type: error.name };
  }
  return { message: String(error), stack: '', type: 'Error' };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref();
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
