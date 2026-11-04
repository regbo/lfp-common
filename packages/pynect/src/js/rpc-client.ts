import { PythonError, VenvClosedError, type RemotePythonError } from './errors';
import {
  isWireValueType,
  MESSAGE_KIND,
  PROTOCOL_VERSION,
  RPC_OPERATION,
  WIRE_VALUE_TYPE,
  type RpcOperation,
} from './protocol';
import { createPythonObject, getPythonReference } from './python-object';
import {
  decodeRpcFrame,
  encodeRpcFrame,
  MAX_LOCAL_RPC_FRAME_BYTES,
  RpcFrameDecoder,
} from './rpc-frame';
import type { RpcTransport } from './transport/rpc-transport';
import { withTimeout } from './utils/timing';
import { isRecord } from './utils/validation';

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

interface CallbackEntry {
  readonly callback: JavaScriptCallback;
  leases: number;
}

const referenceFinalizer = new FinalizationRegistry<FinalizedReference>(({ client, id }) => {
  client.deref()?.notify(RPC_OPERATION.release, { target: id });
});

export class RpcClient {
  readonly #transport: RpcTransport;
  readonly #token: string | undefined;
  readonly #callTimeoutMs: number;
  readonly #autoUnref: boolean;
  readonly #frames: RpcFrameDecoder;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #callbacks = new Map<number, CallbackEntry>();
  readonly #callbackIds = new WeakMap<JavaScriptCallback, number>();
  #nextRequestId = 1;
  #nextCallbackId = 1;
  #closed = false;
  #helloSettled = false;
  #pythonPid = 0;
  readonly #hello: Promise<void>;
  #resolveHello!: () => void;
  #rejectHello!: (error: unknown) => void;

  private constructor(
    transport: RpcTransport,
    token: string | undefined,
    callTimeoutMs: number,
    autoUnref: boolean,
    maxFrameBytes: number,
  ) {
    this.#transport = transport;
    this.#token = token;
    this.#callTimeoutMs = callTimeoutMs;
    this.#autoUnref = autoUnref;
    this.#frames = new RpcFrameDecoder(maxFrameBytes);
    this.#hello = new Promise<void>((resolve, reject) => {
      this.#resolveHello = resolve;
      this.#rejectHello = reject;
    });
    transport.setHandlers({
      close: () => this.#fail(new VenvClosedError('Python worker disconnected.')),
      data: data => this.#receive(data),
      error: error => this.#fail(error),
    });
  }

  static async connect(options: {
    readonly autoUnref: boolean;
    readonly callTimeoutMs: number;
    readonly maxFrameBytes?: number;
    readonly timeoutMs: number;
    readonly token?: string;
    readonly transport: RpcTransport;
  }): Promise<RpcClient> {
    const client = new RpcClient(
      options.transport,
      options.token,
      options.callTimeoutMs,
      options.autoUnref,
      options.maxFrameBytes ?? MAX_LOCAL_RPC_FRAME_BYTES,
    );
    try {
      await withTimeout(client.#hello, options.timeoutMs, 'Python worker handshake timed out.');
    } catch (error) {
      client.forceClose(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
    if (options.autoUnref) options.transport.unref();
    return client;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get pythonPid(): number {
    if (this.#pythonPid <= 0) throw new Error('Python worker handshake is incomplete.');
    return this.#pythonPid;
  }

  request(
    operation: RpcOperation,
    payload: Readonly<Record<string, unknown>> = {},
  ): Promise<unknown> {
    if (this.#closed) return Promise.reject(new VenvClosedError());
    const id = this.#nextRequestId++;
    if (this.#autoUnref) this.#transport.ref();
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
    const callbackLeases: number[] = [];
    let encodedPayload: unknown;
    try {
      encodedPayload = this.#encodeValue(payload, new Set(), callbackLeases);
    } catch (error) {
      this.#rollbackCallbackLeases(callbackLeases);
      this.#rejectPending(id, error);
      return promise.finally(() => this.#unrefWhenIdle());
    }
    void this.#send({
      id,
      kind: MESSAGE_KIND.request,
      op: operation,
      payload: encodedPayload,
    }).catch(error => {
      this.#rollbackCallbackLeases(callbackLeases);
      this.#rejectPending(id, error);
    });
    return promise.finally(() => this.#unrefWhenIdle());
  }

  notify(operation: RpcOperation, payload: Readonly<Record<string, unknown>> = {}): void {
    if (this.#closed) return;
    const callbackLeases: number[] = [];
    let encodedPayload: unknown;
    try {
      encodedPayload = this.#encodeValue(payload, new Set(), callbackLeases);
    } catch {
      this.#rollbackCallbackLeases(callbackLeases);
      return;
    }
    void this.#send({
      kind: MESSAGE_KIND.notify,
      op: operation,
      payload: encodedPayload,
    }).catch(() => this.#rollbackCallbackLeases(callbackLeases));
  }

  release(id: number): Promise<void> {
    return this.request(RPC_OPERATION.release, { target: id }).then(() => undefined);
  }

  trackReference(value: object, id: number): void {
    referenceFinalizer.register(value, { client: new WeakRef(this), id }, value);
  }

  untrackReference(value: object): void {
    referenceFinalizer.unregister(value);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    try {
      await withTimeout(
        this.request(RPC_OPERATION.shutdown),
        2_000,
        'Python worker shutdown timed out.',
      );
    } catch {
      // The owning Venv terminates an unresponsive child after this transport closes.
    }
    this.#closed = true;
    this.#transport.close();
    this.#transport.destroy();
    this.#callbacks.clear();
    this.#fail(new VenvClosedError());
  }

  forceClose(error = new VenvClosedError()): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#transport.destroy();
    this.#fail(error);
  }

  #receive(data: Uint8Array): void {
    try {
      for (const frame of this.#frames.push(data)) {
        this.#handleMessage(decodeRpcFrame(frame));
      }
    } catch (error) {
      this.#fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #handleMessage(value: unknown): void {
    if (!isRecord(value) || typeof value['kind'] !== 'string') {
      throw new TypeError('Python worker sent an invalid message.');
    }
    switch (value['kind']) {
      case MESSAGE_KIND.hello:
        this.#handleHello(value);
        return;
      case MESSAGE_KIND.response:
        this.#handleResponse(value);
        return;
      case MESSAGE_KIND.callback:
        void this.#handleCallback(value);
        return;
      case MESSAGE_KIND.callbackRelease:
        this.#handleCallbackRelease(value);
        return;
      default:
        throw new TypeError(`Python worker sent an unknown message kind: ${value['kind']}`);
    }
  }

  #handleHello(message: Record<string, unknown>): void {
    if (this.#helloSettled) throw new Error('Python worker sent more than one handshake.');
    this.#helloSettled = true;
    if (
      message['protocol'] !== PROTOCOL_VERSION ||
      (this.#token !== undefined && message['token'] !== this.#token) ||
      typeof message['pid'] !== 'number' || !Number.isInteger(message['pid']) || message['pid'] <= 0
    ) {
      const error = new Error('Python worker handshake validation failed.');
      this.#rejectHello(error);
      this.#fail(error);
      return;
    }
    this.#pythonPid = message['pid'];
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
    const callback = this.#callbacks.get(callbackId)?.callback;
    this.#transport.ref();
    try {
      if (!callback) throw new Error(`JavaScript callback ${callbackId} is unavailable.`);
      const argsValue = this.#decodeValue(message['args']);
      const kwargsValue = this.#decodeValue(message['kwargs']);
      const args = Array.isArray(argsValue) ? argsValue : [];
      if (isRecord(kwargsValue) && Object.keys(kwargsValue).length > 0) args.push(kwargsValue);
      const result = await callback(...args);
      const callbackLeases: number[] = [];
      try {
        const encodedResult = this.#encodeValue(result, new Set(), callbackLeases);
        await this.#send({
          id: requestId,
          kind: MESSAGE_KIND.callbackResult,
          ok: true,
          value: encodedResult,
        });
      } catch (error) {
        this.#rollbackCallbackLeases(callbackLeases);
        throw error;
      }
    } catch (error) {
      await this.#send({
        error: serializeJavaScriptError(error),
        id: requestId,
        kind: MESSAGE_KIND.callbackResult,
        ok: false,
      }).catch(() => undefined);
    } finally {
      this.#unrefWhenIdle();
    }
  }

  #handleCallbackRelease(message: Record<string, unknown>): void {
    const callbackId = message['callback'];
    if (typeof callbackId !== 'number') {
      throw new TypeError('Python callback release has no numeric callback id.');
    }
    this.#releaseCallbackLease(callbackId);
  }

  #encodeValue(
    value: unknown,
    seen = new Set<object>(),
    callbackLeases: number[] = [],
  ): unknown {
    if (
      value === null || typeof value === 'string' || typeof value === 'boolean' ||
      typeof value === 'number' || typeof value === 'bigint'
    ) return value;
    if (value === undefined) return { [WIRE_TYPE]: WIRE_VALUE_TYPE.undefined };

    const reference = getPythonReference(value);
    if (reference) {
      if (reference.client !== this) {
        throw new TypeError('A Python object cannot cross between different Venv instances.');
      }
      if (reference.path.length > 0) {
        throw new TypeError('Await a Python attribute before passing it back to Python.');
      }
      return { [WIRE_TYPE]: WIRE_VALUE_TYPE.reference, id: reference.id };
    }

    if (typeof value === 'function') {
      const callback = value as JavaScriptCallback;
      let id = this.#callbackIds.get(callback);
      let entry = id === undefined ? undefined : this.#callbacks.get(id);
      if (id === undefined || !entry) {
        id = this.#nextCallbackId++;
        entry = { callback, leases: 0 };
        this.#callbackIds.set(callback, id);
        this.#callbacks.set(id, entry);
      }
      entry.leases += 1;
      callbackLeases.push(id);
      return { [WIRE_TYPE]: WIRE_VALUE_TYPE.callback, id };
    }
    if (typeof value !== 'object') {
      throw new TypeError(`Cannot pass ${typeof value} values to Python.`);
    }
    if (seen.has(value)) throw new TypeError('Cannot pass circular JavaScript values to Python.');
    seen.add(value);
    try {
      if (value instanceof Date) {
        return { [WIRE_TYPE]: WIRE_VALUE_TYPE.datetime, value: value.toISOString() };
      }
      if (value instanceof Uint8Array) return value;
      if (Array.isArray(value)) {
        return value.map(item => this.#encodeValue(item, seen, callbackLeases));
      }
      if (value instanceof Set) {
        return {
          [WIRE_TYPE]: WIRE_VALUE_TYPE.set,
          value: [...value].map(item => this.#encodeValue(item, seen, callbackLeases)),
        };
      }
      if (value instanceof Map) {
        return {
          [WIRE_TYPE]: WIRE_VALUE_TYPE.map,
          value: [...value].map(([key, item]) => [
            this.#encodeValue(key, seen, callbackLeases),
            this.#encodeValue(item, seen, callbackLeases),
          ]),
        };
      }
      const record = value as Record<string, unknown>;
      if (WIRE_TYPE in record) {
        return {
          [WIRE_TYPE]: WIRE_VALUE_TYPE.map,
          value: Object.entries(record).map(([key, item]) => [
            key,
            this.#encodeValue(item, seen, callbackLeases),
          ]),
        };
      }
      return Object.fromEntries(
        Object.entries(record).map(([key, item]) => [
          key,
          this.#encodeValue(item, seen, callbackLeases),
        ]),
      );
    } finally {
      seen.delete(value);
    }
  }

  #decodeValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(item => this.#decodeValue(item));
    if (value instanceof Uint8Array) return value;
    if (!isRecord(value)) return value;
    const type = value[WIRE_TYPE];
    if (type !== undefined && !isWireValueType(type)) {
      throw new TypeError(`Python worker sent an unknown wire value type: ${String(type)}`);
    }
    switch (type) {
      case WIRE_VALUE_TYPE.reference: {
        const id = value['id'];
        if (typeof id !== 'number') throw new TypeError('Python reference has no numeric id.');
        return createPythonObject(
          this,
          id,
          typeof value['pythonType'] === 'string' ? value['pythonType'] : undefined,
        );
      }
      case WIRE_VALUE_TYPE.undefined: return undefined;
      case WIRE_VALUE_TYPE.datetime:
      case WIRE_VALUE_TYPE.date: {
        const date = new Date(String(value['value']));
        return Number.isNaN(date.valueOf()) ? String(value['value']) : date;
      }
      case WIRE_VALUE_TYPE.time: return String(value['value']);
      case WIRE_VALUE_TYPE.set: {
        const items = value['value'];
        return new Set(Array.isArray(items) ? items.map(item => this.#decodeValue(item)) : []);
      }
      case WIRE_VALUE_TYPE.map: {
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
    await this.#transport.send(encodeRpcFrame(message, this.#frames.maxFrameBytes));
  }

  #rejectPending(id: number, error: unknown): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    pending.reject(error);
    this.#unrefWhenIdle();
  }

  #rollbackCallbackLeases(callbackIds: readonly number[]): void {
    for (const id of callbackIds) this.#releaseCallbackLease(id);
  }

  #releaseCallbackLease(id: number): void {
    const entry = this.#callbacks.get(id);
    if (!entry) return;
    entry.leases -= 1;
    if (entry.leases > 0) return;
    this.#callbacks.delete(id);
    this.#callbackIds.delete(entry.callback);
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
    this.#callbacks.clear();
    this.#frames.reset();
    if (!this.#transport.closed) this.#transport.destroy();
  }

  #unrefWhenIdle(): void {
    if (this.#autoUnref && this.#pending.size === 0 && !this.#closed) this.#transport.unref();
  }
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
