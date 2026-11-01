import { AsyncLocalStorage } from 'async_hooks';
import type { NativeAddon } from '../types/addon';
import type { SerializedValue } from '../types/python';

export type Awaitable<T> = T | PromiseLike<T>;

const callbackBrand: unique symbol = Symbol('pynect.callback');

/** A JavaScript callback registered with one live Pynect runtime. */
export type PynectCallback<Args extends unknown[] = unknown[], Result = unknown> =
  ((...args: Args) => Awaitable<Result>) & {
    readonly [callbackBrand]: true;
    readonly disposed: boolean;
    dispose(): void;
    [Symbol.dispose](): void;
  };

interface CallbackCodec {
  decode(value: unknown): unknown;
  encode(value: unknown): Promise<SerializedValue>;
}

export interface PynectCallbackContext {
  readonly disposed: boolean;
  callback<Fn extends (...args: never[]) => unknown>(
    fn: Fn,
  ): PynectCallback<Parameters<Fn>, Awaited<ReturnType<Fn>>>;
}

interface NativeCallbackInvocation {
  depth: number;
  args: unknown[];
  kwargs: Record<string, unknown>;
  resolve(value: SerializedValue): void;
  reject(error: { name: string; message: string; stack?: string }): void;
}

interface CallbackRegistration {
  addon: NativeAddon;
  callbackId: number;
  disposed: boolean;
  onDispose(): void;
}

const callbackDepth = new AsyncLocalStorage<number>();
const registrations = new WeakMap<Function, CallbackRegistration>();

export function currentCallbackDepth(): number {
  return callbackDepth.getStore() ?? 0;
}

export function createPynectCallback<Fn extends (...args: never[]) => unknown>(
  addon: NativeAddon,
  fn: Fn,
  codec: CallbackCodec,
  onDispose: () => void,
): PynectCallback<Parameters<Fn>, Awaited<ReturnType<Fn>>> {
  if (typeof fn !== 'function') throw new TypeError('Pynect callback expects a function.');

  const dispatcher = (invocation: NativeCallbackInvocation): void => {
    callbackDepth.run(invocation.depth, () => {
      void Promise.resolve().then(async () => {
        const args = invocation.args.map(value => codec.decode(value));
        const kwargs = Object.fromEntries(
          Object.entries(invocation.kwargs).map(([key, value]) => [key, codec.decode(value)]),
        );
        if (Object.keys(kwargs).length > 0) args.push(kwargs);
        const result = await fn(...args as Parameters<Fn>);
        invocation.resolve(await codec.encode(result));
      }).catch((error: unknown) => {
        const value = error instanceof Error ? error : new Error(String(error));
        invocation.reject({ name: value.name, message: value.message, stack: value.stack });
      });
    });
  };

  const callbackId = addon.registerCallback(dispatcher);
  const wrapper = function pynectCallback(
    ...args: Parameters<Fn>
  ): ReturnType<Fn> {
    return fn(...args) as ReturnType<Fn>;
  } as PynectCallback<Parameters<Fn>, Awaited<ReturnType<Fn>>>;
  const registration: CallbackRegistration = {
    addon,
    callbackId,
    disposed: false,
    onDispose,
  };
  registrations.set(wrapper, registration);

  const dispose = (): void => {
    if (registration.disposed) return;
    registration.disposed = true;
    addon.disposeCallback(callbackId);
    onDispose();
  };
  Object.defineProperties(wrapper, {
    disposed: { enumerable: false, get: () => registration.disposed },
    dispose: { enumerable: false, value: dispose },
    [Symbol.dispose]: { enumerable: false, value: dispose },
  });
  return wrapper;
}

export function createPynectCallbackContext(
  addon: NativeAddon,
  codec: CallbackCodec,
  onDispose: () => void,
): PynectCallbackContext & Disposable {
  const owned = new Set<{ dispose(): void }>();
  let disposed = false;
  const context: PynectCallbackContext & Disposable = {
    get disposed() { return disposed; },
    callback<Fn extends (...args: never[]) => unknown>(
      fn: Fn,
    ): PynectCallback<Parameters<Fn>, Awaited<ReturnType<Fn>>> {
      if (disposed) throw new Error('Pynect callback context has been disposed.');
      let registered: PynectCallback<Parameters<Fn>, Awaited<ReturnType<Fn>>>;
      registered = createPynectCallback(addon, fn, codec, () => owned.delete(registered));
      owned.add(registered);
      return registered;
    },
    [Symbol.dispose](): void {
      if (disposed) return;
      disposed = true;
      for (const callback of [...owned]) callback.dispose();
      owned.clear();
      onDispose();
    },
  };
  return context;
}

export function serializePynectCallback(
  value: unknown,
  addon: NativeAddon,
): SerializedValue | undefined {
  if (typeof value !== 'function') return undefined;
  const registration = registrations.get(value);
  if (!registration) return undefined;
  if (registration.disposed) throw new Error('Pynect callback has been disposed.');
  if (registration.addon !== addon) {
    throw new Error('Pynect callback belongs to a different runtime.');
  }
  return {
    format: 9,
    data: null,
    metadata: { callbackId: registration.callbackId },
  };
}
