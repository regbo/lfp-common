/**
 * pynect - PyCallable
 * Represents a Python callable (function, method, class constructor).
 * Extends PyProxy with call metadata and convenience methods.
 */

import { PyProxy, PYPROXY_INTERNAL } from './py-proxy';
import type { NativeAddon } from '../types/addon';
import type { PyCallOptions } from '../types/addon';
import type { PyObjectId, AttributePath, PyCallableInfo } from '../types/python';

/**
 * PyCallable - wraps a Python function or method.
 *
 * @example
 * ```typescript
 * const np = await py.import('numpy');
 * const zeros = await np.zeros;  // PyCallable
 * const arr = await zeros([3, 3], { dtype: 'float64' });
 *
 * // Or more concisely:
 * const arr2 = await np.zeros([3, 3]);
 * ```
 */
export class PyCallable extends PyProxy {
  private readonly _callableName: string;

  constructor(
    objectId: PyObjectId,
    path: AttributePath,
    callableName: string,
    addon: NativeAddon,
    callTimeout?: number,
    executionTimeout?: number,
  ) {
    super({
      objectId,
      path,
      addon,
      callTimeout,
      executionTimeout,
    });
    this._callableName = callableName;
  }

  /** Callable name */
  get callableName(): string {
    return this._callableName;
  }

  /**
   * Call the callable with given arguments.
   * Same as using the callable directly (proxy syntax).
   *
   * @example
   * ```typescript
   * const result = await callable.invoke([1, 2, 3], { axis: 0 });
   * // equivalent to: await callable([1, 2, 3], { axis: 0 })
   * ```
   */
  async invoke(...args: unknown[]): Promise<unknown> {
    return (this as unknown as (...a: unknown[]) => unknown)(...args);
  }

  /** Invoke with cancellation or per-call timeout overrides. */
  async invokeWithOptions(options: PyCallOptions, ...args: unknown[]): Promise<unknown> {
    return this.withOptions(options, ...args);
  }

  /**
   * Call with explicit positional args and keyword args.
   *
   * @example
   * ```typescript
   * const result = await callable.call([1, 2, 3], { axis: 0, keepdims: true });
   * ```
   */
  async call(
    args: unknown[],
    kwargs?: Record<string, unknown>,
    options: PyCallOptions = {},
  ): Promise<unknown> {
    return this.callWithOptions(args, options, kwargs);
  }

  /**
   * Partially apply arguments (like functools.partial in Python).
   *
   * @example
   * ```typescript
   * const readCsvUtf8 = await pd.read_csv.partial({ encoding: 'utf-8' });
   * const df = await readCsvUtf8('data.csv');
   * ```
   */
  partial(...partialArgs: unknown[]): PyCallable {
    const internal = this[PYPROXY_INTERNAL];
    const callableName = `${this._callableName}(partial)`;
    const wrapper = new PyCallable(
      internal.objectId,
      internal.path,
      callableName,
      internal.addon,
      internal.callTimeout,
      internal.executionTimeout,
    );

    // Override: always prepend partialArgs (use arrow to capture outer `this` lexically)
    const callSelf = (...a: unknown[]) =>
      (this as unknown as (...x: unknown[]) => unknown)(...a);
    const overrideProxy = new Proxy(wrapper, {
      apply(_target, _thisArg, args: unknown[]) {
        return callSelf(...partialArgs, ...args);
      },
    });

    return overrideProxy as PyCallable;
  }

  /**
   * Get introspection information about this callable.
   */
  async getInfo(): Promise<PyCallableInfo | null> {
    return null;
  }

  static fromProxy(proxy: PyProxy, name: string): PyCallable {
    const internal = proxy[PYPROXY_INTERNAL];
    return new PyCallable(
      internal.objectId,
      internal.path,
      name,
      internal.addon,
      internal.callTimeout,
      internal.executionTimeout,
    );
  }

  override toString(): string {
    return `[PyCallable '${this._callableName}' id=${this[PYPROXY_INTERNAL].objectId}]`;
  }
}
