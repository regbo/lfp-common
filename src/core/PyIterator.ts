/**
 * pynect - PyIterator
 * Wraps a Python iterator for use with JavaScript's for await...of.
 * Provides both async iteration and manual .next() calls.
 */

import type { NativeAddon } from '../types/addon';
import type { PyObjectId } from '../types/python';
import { translatePythonError } from '../utils/ErrorTranslator';
import { PyProxy, PYPROXY_INTERNAL } from './PyProxy';
import { Logger } from '../utils/Logger';

const logger = new Logger('PyIterator');

export interface PyIteratorOptions {
  /** Maximum number of items to yield (0 = no limit) */
  limit?: number;
  /** Whether to wrap Python objects in PyProxy */
  wrapObjects?: boolean;
  /** Timeout per .next() call (ms) */
  timeout?: number;
}

/**
 * PyIterator - manages a Python iterator lifecycle.
 *
 * @example
 * ```typescript
 * const iterator = await PyIterator.create(pyList, addon);
 *
 * for await (const item of iterator) {
 * console.log(item);
 * }
 *
 * // Or manually:
 * const { value, done } = await iterator.next();
 * ```
 */
export class PyIterator<T = unknown> implements AsyncIterable<T>, AsyncIterator<T> {
  private readonly _iteratorId: number;
  private readonly _addon: NativeAddon;
  private readonly _objectId: PyObjectId;
  private readonly _options: PyIteratorOptions;
  private _done = false;
  private _position = 0;
  private _destroyed = false;

  private constructor(
    iteratorId: number,
    objectId: PyObjectId,
    addon: NativeAddon,
    options: PyIteratorOptions = {}
  ) {
    this._iteratorId = iteratorId;
    this._objectId = objectId;
    this._addon = addon;
    this._options = options;
  }

  /**
   * Create a PyIterator from a PyProxy.
   */
  static async create(
    source: PyProxy,
    options?: PyIteratorOptions
  ): Promise<PyIterator> {
    const internal = source[PYPROXY_INTERNAL];
    const addon = internal.addon;

    const result = await addon.createIterator(
      internal.objectId as number,
      internal.path
    ) as { success?: boolean; resultJson?: string; error?: { type: string; message: string; traceback: string } };

    if (!result.success) {
      if (result.error) {
        throw translatePythonError({
          type: result.error.type,
          message: result.error.message,
          traceback: result.error.traceback || '',
        });
      }
      throw new Error('Failed to create Python iterator');
    }

    let iteratorId: number;
    try {
      const parsed = JSON.parse(result.resultJson || '{}') as { iteratorId?: number };
      if (!parsed.iteratorId) {throw new Error('no iteratorId');}
      iteratorId = parsed.iteratorId;
    } catch {
      throw new Error('Failed to parse iterator ID from: ' + result.resultJson);
    }

    return new PyIterator(iteratorId, internal.objectId, addon, options);
  }

  /**
   * Create a PyIterator from an object ID and iterator ID directly.
   */
  static fromIds(
    iteratorId: number,
    objectId: PyObjectId,
    addon: NativeAddon,
    options?: PyIteratorOptions
  ): PyIterator {
    return new PyIterator(iteratorId, objectId, addon, options);
  }

  /** Current position in iteration */
  get position(): number {
    return this._position;
  }

  /** Whether iteration is complete */
  get isDone(): boolean {
    return this._done;
  }

  // AsyncIterator Protocol

  async next(): Promise<IteratorResult<T>> {
    if (this._done || this._destroyed) {
      return { value: undefined as unknown as T, done: true };
    }

    // Check limit
    if (this._options.limit && this._position >= this._options.limit) {
      await this.destroy();
      return { value: undefined as unknown as T, done: true };
    }

    try {
      const result = await this._addon.iteratorNext(this._iteratorId) as {
        success?: boolean;
        resultJson?: string;
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
        this._done = true;
        return { value: undefined as unknown as T, done: true };
      }

      let parsed: { done?: boolean; value?: unknown };
      try {
        parsed = JSON.parse(result.resultJson || '{"done":true}') as { done?: boolean; value?: unknown };
      } catch {
        this._done = true;
        return { value: undefined as unknown as T, done: true };
      }

      if (parsed.done) {
        this._done = true;
        return { value: undefined as unknown as T, done: true };
      }

      this._position++;

      // Deserialize the value
      const rawValue = parsed.value;
      let value: T;

      if (
        rawValue !== null &&
        typeof rawValue === 'object' &&
        '__pyref__' in (rawValue as Record<string, unknown>)
      ) {
        // It's a Python object reference
        if (this._options.wrapObjects !== false) {
          const refId = (rawValue as { __pyref__: number }).__pyref__;
          value = PyProxy._createFromObjectId(
            refId as PyObjectId,
            [],
            this._addon
          ) as unknown as T;
        } else {
          value = rawValue as T;
        }
      } else {
        value = rawValue as T;
      }

      return { value, done: false };
    } catch (err) {
      this._done = true;
      throw err;
    }
  }

  async return(value?: T): Promise<IteratorResult<T>> {
    await this.destroy();
    return { value: value as T, done: true };
  }

  async throw(error?: unknown): Promise<IteratorResult<T>> {
    await this.destroy();
    throw error;
  }

  // AsyncIterable Protocol

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }

  // Utilities

  /**
   * Collect all items into an array.
   * Use with care for large iterators!
   */
  async toArray(maxItems = 100000): Promise<T[]> {
    const items: T[] = [];
    for await (const item of this) {
      items.push(item);
      if (items.length >= maxItems) {break;}
    }
    return items;
  }

  /**
   * Process items in batches.
   */
  async *batch(batchSize: number): AsyncGenerator<T[]> {
    let current: T[] = [];
    for await (const item of this) {
      current.push(item);
      if (current.length >= batchSize) {
        yield current;
        current = [];
      }
    }
    if (current.length > 0) {
      yield current;
    }
  }

  /**
   * Map items through a transform function.
   */
  async *map<U>(fn: (item: T, index: number) => U | Promise<U>): AsyncGenerator<U> {
    let i = 0;
    for await (const item of this) {
      yield await fn(item, i++);
    }
  }

  /**
   * Filter items.
   */
  async *filter(fn: (item: T, index: number) => boolean | Promise<boolean>): AsyncGenerator<T> {
    let i = 0;
    for await (const item of this) {
      if (await fn(item, i++)) {yield item;}
    }
  }

  /**
   * Take first N items.
   */
  async take(n: number): Promise<T[]> {
    const items: T[] = [];
    for await (const item of this) {
      items.push(item);
      if (items.length >= n) {break;}
    }
    await this.destroy();
    return items;
  }

  /**
   * Destroy the underlying Python iterator (frees resources).
   * Called automatically when iteration completes.
   */
  async destroy(): Promise<void> {
    if (this._destroyed) {return;}
    this._destroyed = true;
    this._done = true;
    try {
      await this._addon.destroyIterator(this._iteratorId);
    } catch (err) {
      logger.debug('Error destroying iterator', err);
    }
  }
}
