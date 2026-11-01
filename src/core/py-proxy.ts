/**
 * pynect - PyProxy
 *
 * The heart of pynect's JavaScript API.
 * Every Python object is represented as a PyProxy - a JavaScript Proxy that:
 *
 * 1. Intercepts property access -> creates lazy child PyProxy
 * 2. Intercepts function call -> sends to Python worker thread
 * 3. Intercepts `then` -> resolves the proxy chain into a value (makes it awaitable)
 * 4. Intercepts Symbol.iterator -> enables for...of loops
 * 5. Intercepts Symbol.asyncIterator -> enables for await...of loops
 * 6. Intercepts property assignment -> sets Python attribute
 *
 * The key insight: attributes are NOT resolved eagerly. The chain
 * `df.groupby('country').agg({'sales': 'sum'}).reset_index()`
 * creates a chain of PyProxy objects, each recording the operation,
 * and only executes when you `await` the final result.
 */

import type { NativeAddon, AddonCallOptions, PyCallOptions } from '../types/addon';
import type {
  PyObjectId,
  AttributePath,
  SerializedValue,
} from '../types/python';
import { translatePythonError } from '../utils/error-translator';
import { Logger } from '../utils/logger';
import {
  currentCallbackDepth,
  serializePynectCallback,
} from './pynect-callback';

const logger = new Logger('PyProxy');
let nextRequestId = 0;

// Internal symbols used to brand PyProxy and access internals
export const PYPROXY_INTERNAL = Symbol('pynect.internal');
export const PYPROXY_OBJECTID = Symbol('pynect.objectId');
export const PYPROXY_PATH = Symbol('pynect.path');
export const PYNECT_WITH_OPTIONS = Symbol.for('pynect.withOptions');

export type PynectFunction<
  FunctionType extends (...args: never[]) => Promise<unknown>,
> = FunctionType & {
  withOptions(
    options: PyCallOptions,
    ...args: Parameters<FunctionType>
  ): ReturnType<FunctionType>;
  [PYNECT_WITH_OPTIONS](
    options: PyCallOptions,
    ...args: Parameters<FunctionType>
  ): ReturnType<FunctionType>;
};

/**
 * Internal state of a PyProxy.
 */
export interface PyProxyInternal {
  objectId: PyObjectId;
  path: AttributePath;
  addon: NativeAddon;
  callTimeout?: number;
  executionTimeout?: number;
}

/**
 * PyProxy - wraps any Python object in JavaScript.
 *
 * Usage:
 * ```typescript
 * const pd = await py.import('pandas');
 * const df = await pd.read_csv('data.csv');  // df is a PyProxy
 * const rows = await df.describe().to_dict('records');  // chained calls
 * ```
 */
export class PyProxy {
  /** Internal state - do not access directly from outside */
  readonly [PYPROXY_INTERNAL]: PyProxyInternal;

  constructor(internal: PyProxyInternal) {
    this[PYPROXY_INTERNAL] = internal;
    // A Proxy apply trap only works when its target is callable. Use a
    // function target while preserving the concrete PyProxy/PyModule
    // prototype and local state.
    const callable = function pyProxyTarget(): void {} as unknown as PyProxy;
    Object.setPrototypeOf(callable, new.target.prototype);
    Object.defineProperty(callable, PYPROXY_INTERNAL, {
      configurable: false,
      enumerable: false,
      value: internal,
      writable: false,
    });
    return new Proxy(callable, PyProxy.handler);
  }

  // Proxy Handler

  static readonly handler: ProxyHandler<PyProxy> = {
    get(target: PyProxy, prop: string | symbol, receiver: unknown): unknown {
      const internal = target[PYPROXY_INTERNAL];

      // Internal Symbol Access
      if (prop === PYPROXY_INTERNAL || prop === PYPROXY_OBJECTID || prop === PYPROXY_PATH) {
        return Reflect.get(target, prop, receiver);
      }

      // JavaScript built-in symbols
      if (typeof prop === 'symbol') {
        // Make for...of work (synchronous iteration via async iterator)
        if (prop === Symbol.asyncIterator) {
          return () => target._makeAsyncIterator(internal);
        }

        // Symbol.iterator - not directly supported for Python objects
        if (prop === Symbol.iterator) {
          return () => {
            throw new Error(
              'Python objects are not synchronously iterable from JavaScript. ' +
              'Use "for await...of" instead.'
            );
          };
        }

        // Symbol.toPrimitive - for coercion
        if (prop === Symbol.toPrimitive) {
          return (hint: string) => {
            if (hint === 'string') {return `[PyProxy id=${internal.objectId}]`;}
            return NaN;
          };
        }

        // Symbol.toStringTag
        if (prop === Symbol.toStringTag) {
          return 'PyProxy';
        }

        return Reflect.get(target, prop, receiver);
      }

      const prototype = Object.getPrototypeOf(target) as object | null;
      const isLocal = Object.prototype.hasOwnProperty.call(target, prop) ||
        (prototype !== null && prop in prototype && !(prop in Function.prototype));
      if (isLocal) {
        return Reflect.get(target, prop, receiver);
      }

      // toString / valueOf
      if (prop === 'toString') {
        return () => `[PyProxy id=${internal.objectId} path=${internal.path.join('.')}]`;
      }

      if (prop === 'valueOf') {
        return () => target;
      }

      // then (Thenable - makes it work with await)
      if (prop === 'then') {
        // Root proxies are stable object handles. Marking them as thenables
        // makes Promise resolution recursively unwrap the same Python object.
        if (internal.path.length === 0) {return undefined;}
        return (
          onfulfilled?: (value: unknown) => unknown,
          onrejected?: (reason: unknown) => unknown
        ): Promise<unknown> => {
          return target._resolve(internal).then(onfulfilled, onrejected);
        };
      }

      // catch / finally (Promise chain support)
      if (prop === 'catch') {
        if (internal.path.length === 0) {return undefined;}
        return (onrejected?: (reason: unknown) => unknown) =>
          target._resolve(internal).catch(onrejected);
      }

      if (prop === 'finally') {
        if (internal.path.length === 0) {return undefined;}
        return (onfinally?: () => void) =>
          target._resolve(internal).finally(onfinally);
      }

      // Internal pynect methods
      if (prop.startsWith('__pynect_')) {
        return Reflect.get(target, prop, receiver);
      }

      // Create lazy child PyProxy
      const childInternal: PyProxyInternal = {
        objectId: internal.objectId,
        path: [...internal.path, prop],
        addon: internal.addon,
        callTimeout: internal.callTimeout,
        executionTimeout: internal.executionTimeout,
      };
      return new PyProxy(childInternal);
    },

    // Function call (proxy() or proxy.method())
    apply(target: PyProxy, _thisArg: unknown, args: unknown[]): Promise<unknown> {
      const internal = target[PYPROXY_INTERNAL];
      return target._call(internal, args);
    },

    // Property assignment
    set(target: PyProxy, prop: string | symbol, value: unknown): boolean {
      const internal = target[PYPROXY_INTERNAL];

      if (typeof prop === 'symbol') {
        return Reflect.set(target, prop, value);
      }
      const prototype = Object.getPrototypeOf(target) as object | null;
      const isLocal = prop.startsWith('_') ||
        Object.prototype.hasOwnProperty.call(target, prop) ||
        (prototype !== null && prop in prototype && !(prop in Function.prototype));
      if (isLocal || prop.startsWith('__pynect_')) {
        return Reflect.set(target, prop, value);
      }

      // Schedule async setAttribute (best-effort, no await)
      target._setAttr(internal, String(prop), value).catch(err => {
        logger.error(`Failed to set Python attribute '${String(prop)}'`, err);
      });

      return true;
    },

    // has() - needed for 'in' operator
    has(_target: PyProxy, _prop: string | symbol): boolean {
      // We can't know without checking Python; return true for everything
      return true;
    },

    // deleteProperty
    deleteProperty(target: PyProxy, prop: string | symbol): boolean {
      if (typeof prop === 'string') {
        const internal = target[PYPROXY_INTERNAL];
        internal.addon.deleteAttribute(internal.objectId as number, prop).catch(err => {
          logger.error(`Failed to delete Python attribute '${prop}'`, err);
        });
      }
      return true;
    },

    // ownKeys - for Object.keys()
    ownKeys(_target: PyProxy): (string | symbol)[] {
      // Can't synchronously get Python keys; return empty
      return [];
    },

    getOwnPropertyDescriptor(_target: PyProxy, prop: string | symbol): PropertyDescriptor | undefined {
      if (typeof prop === 'symbol') {return undefined;}
      return {
        enumerable: false,
        configurable: true,
        writable: false,
        value: undefined,
      };
    },
  };

  // Resolution (await)

  private async _resolve(internal: PyProxyInternal): Promise<unknown> {
    try {
      const addon = internal.addon;

      if (internal.path.length === 0) {
        // Resolve the object itself
        const result = await addon.getObjectValue(internal.objectId as number);
        return PyProxy._deserializeAddonResult(result, internal);
      }

      // Resolve attribute path
      const result = await addon.getAttributePath(
        internal.objectId as number,
        internal.path
      );
      return PyProxy._deserializeAddonResult(result, internal);
    } catch (err) {
      if (err && typeof err === 'object' && 'pythonType' in err) {
        throw translatePythonError({
          type: (err as { pythonType: string }).pythonType,
          message: (err as unknown as { message: string }).message,
          traceback: (err as unknown as { pythonTraceback: string }).pythonTraceback || '',
        });
      }
      throw err;
    }
  }

  // Function Call

  async callWithOptions(
    args: unknown[],
    options: PyCallOptions = {},
    kwargs?: Record<string, unknown>,
  ): Promise<unknown> {
    const combined = kwargs ? [...args, kwargs] : args;
    return this._call(this[PYPROXY_INTERNAL], combined, options);
  }

  /** Call this Python function with cancellation or timeout overrides. */
  async withOptions(options: PyCallOptions, ...args: unknown[]): Promise<unknown> {
    return this._call(this[PYPROXY_INTERNAL], args, options);
  }

  /** Collision-free form of withOptions(). */
  async [PYNECT_WITH_OPTIONS](
    options: PyCallOptions,
    ...args: unknown[]
  ): Promise<unknown> {
    return this._call(this[PYPROXY_INTERNAL], args, options);
  }

  private async _call(
    internal: PyProxyInternal,
    args: unknown[],
    controls: PyCallOptions = {},
  ): Promise<unknown> {
    try {
      const addon = internal.addon;
      if (controls.signal?.aborted) {
        throw PyProxy._abortError();
      }

      // Serialize arguments
      const serializedArgs = await Promise.all(
        args.map(arg => PyProxy._serializeArg(arg, addon))
      );

      const callOptions: AddonCallOptions = {
        args: serializedArgs,
        kwargs: {},
        timeout: controls.queueTimeout ?? internal.callTimeout,
        executionTimeout: controls.executionTimeout ?? internal.executionTimeout,
        requestId: `pynect-${process.pid}-${Date.now()}-${++nextRequestId}`,
        callbackDepth: currentCallbackDepth(),
      };

      // If last arg is a plain object (not PyProxy/Array), treat as kwargs
      if (args.length > 0) {
        const lastArg = args[args.length - 1];
        if (
          lastArg !== null &&
          typeof lastArg === 'object' &&
          !Array.isArray(lastArg) &&
          !(lastArg instanceof PyProxy) &&
          !(lastArg instanceof ArrayBuffer) &&
          !ArrayBuffer.isView(lastArg) &&
          !('__pyref__' in lastArg) &&
          PyProxy._isPlainObject(lastArg)
        ) {
          // Treat as kwargs
          callOptions.args = serializedArgs.slice(0, -1);
          const kwargsEntries = await Promise.all(
            Object.entries(lastArg as Record<string, unknown>).map(
              async ([k, v]) => [k, await PyProxy._serializeArg(v, addon)] as [string, SerializedValue]
            )
          );
          callOptions.kwargs = Object.fromEntries(kwargsEntries);
        }
      }

      const pending = addon.callFunction(
        internal.objectId as number,
        internal.path,
        callOptions
      );
      const result = controls.signal
        ? await PyProxy._withAbort(pending, controls.signal, addon, callOptions.requestId)
        : await pending;

      return PyProxy._deserializeAddonResult(result, internal);
    } catch (err) {
      if (err && typeof err === 'object' && 'pythonType' in err) {
        throw translatePythonError({
          type: (err as { pythonType: string }).pythonType,
          message: (err as unknown as { message: string }).message,
          traceback: (err as unknown as { pythonTraceback: string }).pythonTraceback || '',
        });
      }
      throw err;
    }
  }

  // Async Iterator (for await...of)

  private async *_makeAsyncIterator(internal: PyProxyInternal): AsyncIterableIterator<unknown> {
    const addon = internal.addon;

    // Create Python iterator
    const iterResult = await addon.createIterator(
      internal.objectId as number,
      internal.path
    );

    const iteratorResult = iterResult as { iteratorId?: number; success?: boolean; error?: { type: string; message: string; traceback: string } };

    if (!iteratorResult.success) {
      const err = iteratorResult.error;
      if (err) {
        throw translatePythonError({
          type: err.type,
          message: err.message,
          traceback: err.traceback || '',
        });
      }
      throw new Error('Failed to create Python iterator');
    }

    // Parse iteratorId from resultJson
    let iteratorId: number;
    try {
      const parsed = JSON.parse((iterResult as unknown as { resultJson: string }).resultJson || '{}');
      iteratorId = parsed.iteratorId;
    } catch {
      throw new Error('Failed to parse iterator ID');
    }

    if (!iteratorId) {
      throw new Error('Iterator ID not returned from Python');
    }

    try {
      while (true) {
        const next = await addon.iteratorNext(iteratorId);
        const nextResult = next as { resultJson?: string; success?: boolean };

        if (!nextResult.success) {
          break;
        }

        let parsed: { done?: boolean; value?: unknown };
        try {
          parsed = JSON.parse(nextResult.resultJson || '{"done":true}');
        } catch {
          break;
        }

        if (parsed.done) {
          break;
        }

        // Deserialize the value
        const value = parsed.value;
        if (value && typeof value === 'object' && '__pyref__' in (value as Record<string, unknown>)) {
          const refId = (value as { __pyref__: number }).__pyref__;
          yield PyProxy._createFromObjectId(refId as PyObjectId, [], addon, internal.callTimeout, internal.executionTimeout);
        } else {
          yield value;
        }
      }
    } finally {
      // Always destroy the iterator
      await addon.destroyIterator(iteratorId).catch(() => {});
    }
  }

  // Set Attribute

  private async _setAttr(
    internal: PyProxyInternal,
    propName: string,
    value: unknown
  ): Promise<void> {
    const serialized = await PyProxy._serializeArg(value, internal.addon);
    await internal.addon.setAttribute(
      internal.objectId as number,
      propName,
      serialized
    );
  }

  // Static Helpers

  static _createFromObjectId(
    objectId: PyObjectId,
    path: AttributePath,
    addon: NativeAddon,
    callTimeout?: number,
    executionTimeout?: number,
  ): PyProxy {
    return new PyProxy({
      objectId,
      path,
      addon,
      callTimeout,
      executionTimeout,
    });
  }

  static _deserializeAddonResult(
    result: unknown,
    internal: PyProxyInternal
  ): unknown {
    const r = result as {
      success?: boolean;
      resultJson?: string;
      objectId?: number;
      isObject?: boolean;
      error?: { type: string; message: string; traceback: string };
    };

    if (!r.success) {
      if (r.error) {
        throw translatePythonError({
          type: r.error.type,
          message: r.error.message,
          traceback: r.error.traceback || '',
        });
      }
      throw new Error('Python call failed without error details');
    }

    if (r.isObject && r.objectId) {
      // Result is a Python object - wrap in PyProxy
      return PyProxy._createFromObjectId(
        r.objectId as PyObjectId,
        [],
        internal.addon,
        internal.callTimeout,
        internal.executionTimeout,
      );
    }

    // Deserialize JSON result
    if (r.resultJson !== undefined && r.resultJson !== null) {
      try {
        const parsed = JSON.parse(r.resultJson);
        if (parsed && typeof parsed === 'object' && '__pyref__' in parsed) {
          return PyProxy._createFromObjectId(
            parsed.__pyref__ as PyObjectId,
            [],
            internal.addon,
            internal.callTimeout,
            internal.executionTimeout,
          );
        }
        return parsed;
      } catch {
        return r.resultJson;
      }
    }

    return null;
  }

  private static _abortError(): Error {
    const error = new Error('Python call was aborted');
    error.name = 'AbortError';
    return error;
  }

  private static _withAbort<T>(
    pending: Promise<T>,
    signal: AbortSignal,
    addon: NativeAddon,
    requestId: string | undefined,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        if (requestId) void addon.cancelCall(requestId).catch(() => undefined);
        pending.catch(() => undefined);
        reject(PyProxy._abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      pending.then(
        value => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        },
        error => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
      );
      if (signal.aborted) onAbort();
    });
  }

  static async _serializeArg(
    value: unknown,
    addon?: NativeAddon,
  ): Promise<SerializedValue> {
    // Already a SerializedValue
    if (
      value !== null &&
      typeof value === 'object' &&
      'format' in (value as Record<string, unknown>)
    ) {
      return value as SerializedValue;
    }

    if (addon) {
      const callback = serializePynectCallback(value, addon);
      if (callback) return callback;
    }
    if (typeof value === 'function') {
      throw new TypeError('JavaScript functions must be registered with ctx.callback() inside withCallbacks().');
    }

    // PyProxy -> pass as Python reference
    if (value instanceof PyProxy) {
      const internal = value[PYPROXY_INTERNAL];
      if (addon && internal.addon !== addon) {
        throw new Error('Python proxy belongs to a different Pynect runtime.');
      }
      if (internal.path.length > 0) {
        const result = await internal.addon.getAttributePath(
          internal.objectId as number,
          internal.path,
        ) as {
          success?: boolean;
          resultJson?: string | null;
          objectId?: number;
          isObject?: boolean;
          error?: { type: string; message: string; traceback: string };
        };
        if (!result.success) {
          if (result.error) {
            throw translatePythonError({
              type: result.error.type,
              message: result.error.message,
              traceback: result.error.traceback || '',
            });
          }
          throw new Error('Unable to resolve Python argument proxy.');
        }
        if (result.isObject && result.objectId) {
          return {
            format: 6 as const,
            data: null,
            metadata: { objectId: result.objectId },
          };
        }
        return {
          format: 0 as const,
          data: result.resultJson ?? 'null',
          metadata: {},
        };
      }
      return {
        format: 6 as const,  // PYTHON_REF
        data: null,
        metadata: { objectId: internal.objectId as number },
      };
    }

    // null / undefined
    if (value === null || value === undefined) {
      return { format: 0 as const, data: 'null', metadata: {} };
    }

    // TypedArrays -> numpy-compatible binary
    if (
      value instanceof Float32Array ||
      value instanceof Float64Array ||
      value instanceof Int8Array ||
      value instanceof Int16Array ||
      value instanceof Int32Array ||
      value instanceof Uint8Array ||
      value instanceof Uint16Array ||
      value instanceof Uint32Array ||
      value instanceof BigInt64Array ||
      value instanceof BigUint64Array
    ) {
      const ta = value;
      const dtype = PyProxy._getTypedArrayDtype(ta);
      return {
        format: 2 as const,  // NUMPY_ARRAY
        data: new Uint8Array(ta.buffer, ta.byteOffset, ta.byteLength),
        metadata: {
          dtype,
          shape: [ta.length],
        },
      };
    }

    // ArrayBuffer
    if (value instanceof ArrayBuffer) {
      return {
        format: 7 as const,  // BYTES
        data: new Uint8Array(value),
        metadata: {},
      };
    }

    // Primitive types
    if (
      typeof value === 'number' ||
      typeof value === 'string' ||
      typeof value === 'boolean'
    ) {
      return {
        format: 0 as const,  // JSON
        data: JSON.stringify(value),
        metadata: {},
      };
    }

    // Array or object - use JSON
    try {
      return {
        format: 0 as const,  // JSON
        data: JSON.stringify(value),
        metadata: {},
      };
    } catch {
      // Can't serialize - this shouldn't happen for plain objects
      return { format: 8 as const, data: null, metadata: {} };  // NONE
    }
  }

  static _getTypedArrayDtype(arr: ArrayBufferView): string {
    if (arr instanceof Float32Array) {return 'float32';}
    if (arr instanceof Float64Array) {return 'float64';}
    if (arr instanceof Int8Array) {return 'int8';}
    if (arr instanceof Int16Array) {return 'int16';}
    if (arr instanceof Int32Array) {return 'int32';}
    if (arr instanceof BigInt64Array) {return 'int64';}
    if (arr instanceof Uint8Array) {return 'uint8';}
    if (arr instanceof Uint16Array) {return 'uint16';}
    if (arr instanceof Uint32Array) {return 'uint32';}
    if (arr instanceof BigUint64Array) {return 'uint64';}
    return 'uint8';
  }

  static _isPlainObject(obj: unknown): boolean {
    if (!obj || typeof obj !== 'object') {return false;}
    const proto = Object.getPrototypeOf(obj);
    return proto === null || proto === Object.prototype;
  }
}

/**
 * Check if a value is a PyProxy.
 */
export function isPyProxy(value: unknown): value is PyProxy {
  return (
    value instanceof PyProxy ||
    (
      value !== null &&
      typeof value === 'object' &&
      PYPROXY_INTERNAL in (value as object)
    )
  );
}
