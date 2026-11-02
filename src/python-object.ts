import type { RpcClient } from './rpc-client';

export const PYTHON_REFERENCE = Symbol('pynect.pythonReference');
const PYTHON_KWARGS = Symbol('pynect.pythonKwargs');

export interface PythonReference {
  readonly client: RpcClient;
  readonly id: number;
  readonly path: readonly string[];
}

export interface PythonKeywordArguments {
  readonly [PYTHON_KWARGS]: true;
  readonly value: Readonly<Record<string, unknown>>;
}

export interface PythonObjectMethods {
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

export type PythonModule = PythonObject;

interface ProxyState extends PythonReference {
  released: boolean;
  readonly type?: string;
}

export function kwargs(value: Readonly<Record<string, unknown>>): PythonKeywordArguments {
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
  return createProxy({ client, id, path: [], released: false, type }, registerFinalizer);
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
  if (registerFinalizer && state.path.length === 0) state.client.trackReference(proxy, state.id);
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
    case '$dir': return () => request(state, 'dir');
    case '$get': return (name: string) => request(state, 'get', [...state.path, name]);
    case '$release': return () => release(state);
    case '$repr': return () => request(state, 'repr');
    case '$set': return (name: string, value: unknown) =>
      request(state, 'set', [...state.path, name], { value }).then(() => undefined);
    case '$value': return () => request(state, 'value');
    case 'toString': return () => `[PythonObject ${state.type ?? `#${state.id}`}]`;
    case 'then':
      if (state.path.length === 0) return undefined;
      return (resolve?: (value: unknown) => unknown, reject?: (error: unknown) => unknown) =>
        request(state, 'get').then(resolve, reject);
    case 'catch':
      if (state.path.length === 0) return undefined;
      return (reject?: (error: unknown) => unknown) => request(state, 'get').catch(reject);
    case 'finally':
      if (state.path.length === 0) return undefined;
      return (handler?: () => void) => request(state, 'get').finally(handler);
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
  return state.client.request('call', {
    args,
    kwargs: keywordArguments,
    path: state.path,
    target: state.id,
  });
}

function request(
  state: ProxyState,
  operation: string,
  path = state.path,
  extra: Readonly<Record<string, unknown>> = {},
): Promise<any> {
  assertOpen(state);
  return state.client.request(operation, { ...extra, path, target: state.id });
}

async function release(state: ProxyState): Promise<void> {
  if (state.released || state.path.length !== 0) return;
  state.released = true;
  await state.client.release(state.id);
}

function createAsyncIterator(state: ProxyState): AsyncIterator<unknown> {
  const iterator = request(state, 'iter') as Promise<PythonObject>;
  return {
    async next(): Promise<IteratorResult<unknown>> {
      const reference = getPythonReference(await iterator);
      if (!reference) throw new TypeError('Python did not return an iterator reference.');
      return reference.client.request('next', { target: reference.id }) as Promise<IteratorResult<unknown>>;
    },
    async return(): Promise<IteratorResult<unknown>> {
      const reference = getPythonReference(await iterator);
      if (reference) await reference.client.release(reference.id);
      return { done: true, value: undefined };
    },
  };
}

function assertOpen(state: ProxyState): void {
  if (state.released) throw new Error(`Python object #${state.id} has been released.`);
}
