import { AsyncLocalStorage } from 'async_hooks';
import type { NativeAddon } from '../types/addon';
import type { SerializedValue } from '../types/python';

export type Awaitable<T> = T | PromiseLike<T>;

/** A JavaScript function accepted by a Python `Callable` parameter. */
export type PynectCallback<Args extends unknown[] = unknown[], Result = unknown> =
  (...args: Args) => Awaitable<Result>;

interface CallbackCodec {
  decode(value: unknown): unknown;
  encode(value: unknown): Promise<SerializedValue>;
}

interface NativeCallbackInvocation {
  depth: number;
  args: unknown[];
  kwargs: Record<string, unknown>;
  resolve(value: SerializedValue): void;
  reject(error: { name: string; message: string; stack?: string }): void;
}

export interface PynectCallbackScope extends Disposable {
  register(fn: (...args: never[]) => unknown): SerializedValue;
}

const callbackDepth = new AsyncLocalStorage<number>();

export function currentCallbackDepth(): number {
  return callbackDepth.getStore() ?? 0;
}

export function createPynectCallbackScope(
  addon: NativeAddon,
  codec: CallbackCodec,
): PynectCallbackScope {
  const callbackIds = new Set<number>();
  let disposed = false;
  return {
    register(fn: (...args: never[]) => unknown): SerializedValue {
      if (disposed) throw new Error('Pynect callback scope has been disposed.');
      if (typeof fn !== 'function') throw new TypeError('Pynect callback expects a function.');

      const dispatcher = (invocation: NativeCallbackInvocation): void => {
        callbackDepth.run(invocation.depth, () => {
          void Promise.resolve().then(async () => {
            const args = invocation.args.map(value => codec.decode(value));
            const kwargs = Object.fromEntries(
              Object.entries(invocation.kwargs).map(([key, value]) => [key, codec.decode(value)]),
            );
            if (Object.keys(kwargs).length > 0) args.push(kwargs);
            const result = await fn(...args as never[]);
            invocation.resolve(await codec.encode(result));
          }).catch((error: unknown) => {
            const value = error instanceof Error ? error : new Error(String(error));
            invocation.reject({ name: value.name, message: value.message, stack: value.stack });
          });
        });
      };

      const callbackId = addon.registerCallback(dispatcher);
      callbackIds.add(callbackId);
      return {
        format: 9,
        data: null,
        metadata: { callbackId },
      };
    },
    [Symbol.dispose](): void {
      if (disposed) return;
      disposed = true;
      for (const callbackId of callbackIds) addon.disposeCallback(callbackId);
      callbackIds.clear();
    },
  };
}
