import type { RpcClient } from './rpc-client';
import { RPC_OPERATION, type RpcOperation } from './protocol';

const PYTHON_REFERENCE = Symbol('pynect.pythonReference');
const PYTHON_KWARGS = Symbol('pynect.pythonKwargs');

interface PythonReference {
  readonly client: RpcClient;
  readonly id: number;
  readonly path: readonly string[];
}

export interface PythonKeywordArguments<
  Values extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
> {
  readonly [PYTHON_KWARGS]: true;
  readonly value: Values;
}

interface PythonObjectMethods {
  readonly $id: number;
  $call(args?: readonly unknown[], kwargs?: Readonly<Record<string, unknown>>): Promise<unknown>;
  $dir(): Promise<string[]>;
  $get(name: string): Promise<unknown>;
  $release(): Promise<void>;
  $repr(): Promise<string>;
  $set(name: string, value: unknown): Promise<void>;
  $value(): Promise<unknown>;
}

export type PythonObject = PythonObjectMethods &
  ((...args: unknown[]) => Promise<unknown>) &
  AsyncIterable<unknown> &
  Record<string, any>;

interface ProxyLifetime {
  finalizerToken?: object;
  released: boolean;
}

interface ProxyState extends PythonReference {
  readonly lifetime: ProxyLifetime;
  readonly type?: string;
}

export function kwargs<Values extends Readonly<Record<string, unknown>>>(
  value: Values,
): PythonKeywordArguments<Values> {
  return Object.freeze({ [PYTHON_KWARGS]: true as const, value });
}

export function isKeywordArguments(value: unknown): value is PythonKeywordArguments {
  return typeof value === 'object' && value !== null && PYTHON_KWARGS in value;
}

export function getPythonReference(value: unknown): PythonReference | undefined {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return undefined;
  return (value as Partial<Record<typeof PYTHON_REFERENCE, PythonReference>>)[PYTHON_REFERENCE];
}

export function createPythonObject(
  client: RpcClient,
  id: number,
  type?: string,
  registerFinalizer = true,
): PythonObject {
  return createProxy({ client, id, lifetime: { released: false }, path: [], type }, registerFinalizer);
}

function createProxy(state: ProxyState, registerFinalizer: boolean): PythonObject {
  const target = function pythonObjectTarget(): void {};
  const proxy = new Proxy(target, {
    apply: (_target, _this, args) => invoke(state, args),
    construct: (_target, args) => invoke(state, args) as Promise<object>,
    get: (_target, property) => getProperty(state, property),
    set: () => {
      throw new TypeError('Python attributes are asynchronous; use object.$set(name, value).');
    },
  }) as unknown as PythonObject;
  if (registerFinalizer && state.path.length === 0) {
    state.lifetime.finalizerToken = proxy;
    state.client.trackReference(proxy, state.id);
  }
  return proxy;
}

function getProperty(state: ProxyState, property: string | symbol): unknown {
  if (property === PYTHON_REFERENCE) return state;
  if (property === Symbol.asyncIterator) return () => createAsyncIterator(state);
  if (property === Symbol.toStringTag) return state.type ?? 'PythonObject';
  if (property === Symbol.toPrimitive) return () => `[PythonObject ${state.type ?? state.id}]`;
  if (property === Symbol.asyncDispose) return () => release(state);
  if (typeof property === 'symbol') return undefined;

  switch (property) {
    case '$id': return state.id;
    case '$call': return (
      args: readonly unknown[] = [],
      keywordArguments: Readonly<Record<string, unknown>> = {},
    ) => call(state, args, keywordArguments);
    case '$dir': return () => request(state, RPC_OPERATION.dir);
    case '$get': return (name: string) => request(state, RPC_OPERATION.get, [...state.path, name]);
    case '$release': return () => release(state);
    case '$repr': return () => request(state, RPC_OPERATION.repr);
    case '$set': return (name: string, value: unknown) =>
      request(state, RPC_OPERATION.set, [...state.path, name], { value }).then(() => undefined);
    case '$value': return () => request(state, RPC_OPERATION.value);
    case 'toString': return () => `[PythonObject ${state.type ?? `#${state.id}`}]`;
    case 'then':
      if (state.path.length === 0) return undefined;
      return (resolve?: (value: unknown) => unknown, reject?: (error: unknown) => unknown) =>
        request(state, RPC_OPERATION.get).then(resolve, reject);
    case 'catch':
      if (state.path.length === 0) return undefined;
      return (reject?: (error: unknown) => unknown) =>
        request(state, RPC_OPERATION.get).catch(reject);
    case 'finally':
      if (state.path.length === 0) return undefined;
      return (handler?: () => void) => request(state, RPC_OPERATION.get).finally(handler);
    default:
      return createProxy({ ...state, path: [...state.path, property] }, false);
  }
}

function invoke(state: ProxyState, args: readonly unknown[]): Promise<unknown> {
  const last = args.at(-1);
  if (isKeywordArguments(last)) return call(state, args.slice(0, -1), last.value);
  return call(state, args, {});
}

function call(
  state: ProxyState,
  args: readonly unknown[],
  keywordArguments: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  assertOpen(state);
  return state.client.request(RPC_OPERATION.call, {
    args,
    kwargs: keywordArguments,
    path: state.path,
    target: state.id,
  });
}

function request(
  state: ProxyState,
  operation: RpcOperation,
  path = state.path,
  extra: Readonly<Record<string, unknown>> = {},
): Promise<any> {
  assertOpen(state);
  return state.client.request(operation, { ...extra, path, target: state.id });
}

async function release(state: ProxyState): Promise<void> {
  if (state.lifetime.released || state.path.length !== 0) return;
  state.lifetime.released = true;
  try {
    await state.client.release(state.id);
    if (state.lifetime.finalizerToken) {
      state.client.untrackReference(state.lifetime.finalizerToken);
      state.lifetime.finalizerToken = undefined;
    }
  } catch (error) {
    state.lifetime.released = false;
    throw error;
  }
}

function createAsyncIterator(state: ProxyState): AsyncIterator<unknown> {
  const iterator = request(state, RPC_OPERATION.iter) as Promise<PythonObject>;
  let finished = false;
  return {
    async next(): Promise<IteratorResult<unknown>> {
      if (finished) return { done: true, value: undefined };
      const remoteIterator = await iterator;
      const reference = getPythonReference(remoteIterator);
      if (!reference) throw new TypeError('Python did not return an iterator reference.');
      try {
        const result = await reference.client.request(RPC_OPERATION.next, {
          target: reference.id,
        }) as IteratorResult<unknown>;
        if (result.done) {
          finished = true;
          await remoteIterator.$release();
        }
        return result;
      } catch (error) {
        finished = true;
        await remoteIterator.$release().catch(() => undefined);
        throw error;
      }
    },
    async return(): Promise<IteratorResult<unknown>> {
      if (!finished) {
        finished = true;
        await (await iterator).$release();
      }
      return { done: true, value: undefined };
    },
  };
}

function assertOpen(state: ProxyState): void {
  if (state.lifetime.released) throw new Error(`Python object #${state.id} has been released.`);
}
