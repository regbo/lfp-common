import {
  ChanxRequestError,
  createClient as createChanxClient,
  type AddressOf,
  type ChannelConnection,
  type ChannelDescriptor,
  type ChanxClient,
  type ChanxMessage,
  type ClientOptions,
  type ConnectOptions,
  type RepliesOf,
  type ReplyOf,
  type RequestOptions,
  type ToClientOf,
  type ToServerOf,
} from '@chanx-js/client';

type AnyChannel = ChannelDescriptor<any, any, any, any>;

type ActionOf<Descriptor extends AnyChannel> = ToServerOf<Descriptor>['action'];
type StreamActionsOf<Descriptor extends AnyChannel> = Descriptor extends {
  readonly streamActions: readonly (infer Action)[];
} ? Extract<Action, ActionOf<Descriptor>> : never;

type RequestResult<
  Descriptor extends AnyChannel,
  Action extends ActionOf<Descriptor>,
> = Action extends StreamActionsOf<Descriptor>
  ? AsyncIterableIterator<ReplyOf<RepliesOf<Descriptor>, Action>>
  : Promise<ReplyOf<RepliesOf<Descriptor>, Action>>;

export type PynectConnection<Descriptor extends AnyChannel> = Omit<
  ChannelConnection<ToServerOf<Descriptor>, ToClientOf<Descriptor>, RepliesOf<Descriptor>>,
  'request'
> & {
  request<Action extends ActionOf<Descriptor>>(
    message: ToServerOf<Descriptor> & { readonly action: Action },
    options?: RequestOptions,
  ): RequestResult<Descriptor, Action>;
};

export type PynectClient = Omit<ChanxClient, 'connect'> & {
  connect<Descriptor extends AnyChannel>(
    descriptor: Descriptor,
    options?: ConnectOptions<AddressOf<Descriptor>>,
  ): PynectConnection<Descriptor>;
};

/** Wrap Chanx so streamable request actions return ref-correlated async iterators. */
export function createPynectClient(options: ClientOptions = {}): PynectClient {
  const client = createChanxClient(options);
  return {
    ...client,
    connect<Descriptor extends AnyChannel>(
      descriptor: Descriptor,
      connectOptions: ConnectOptions<AddressOf<Descriptor>> = {},
    ) {
      const streamActions = new Set(
        (descriptor as Descriptor & { readonly streamActions?: readonly string[] }).streamActions,
      );
      const sharedOptions = { ...connectOptions, share: true };
      const connection = client.connect(descriptor, sharedOptions);
      return new Proxy(connection, {
        get(target, property) {
          if (property === 'request') {
            return (message: ChanxMessage, requestOptions?: RequestOptions) => {
              if (!streamActions.has(message.action)) {
                const runtimeConnection = target as unknown as ChannelConnection<
                  ChanxMessage,
                  ChanxMessage,
                  any
                >;
                return runtimeConnection.request(message, requestOptions);
              }
              const streamConnection = client.connect(descriptor, sharedOptions);
              return requestStream(streamConnection, message, requestOptions);
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  } as unknown as PynectClient;
}

async function* requestStream(
  connection: ChannelConnection<ChanxMessage, ChanxMessage, any>,
  message: ChanxMessage,
  options?: RequestOptions,
): AsyncGenerator<ChanxMessage> {
  const responses = createResponseStream(connection);
  let failure: ChanxRequestError | undefined;
  const stopComplete = connection.onComplete(() => { responses.close(); });
  const stopError = connection.onError(frame => {
    failure = new ChanxRequestError(frame);
    responses.close();
  });
  try {
    const first = await connection.request(message, options) as ChanxMessage;
    if (first.action === 'complete') return;
    yield first;
    for await (const response of responses) yield response;
    if (failure) throw failure;
  } finally {
    stopComplete();
    stopError();
    responses.close();
    connection.close();
  }
}

/** Queue only ref-correlated replies; uncorrelated broadcasts may use the same action. */
function createResponseStream(
  connection: ChannelConnection<ChanxMessage, ChanxMessage, any>,
): AsyncIterableIterator<ChanxMessage> & { close(): void } {
  const queue: ChanxMessage[] = [];
  const waiting: Array<(result: IteratorResult<ChanxMessage>) => void> = [];
  let finished = false;
  const stop = connection.onAny((message, envelope) => {
    if (envelope.ref === undefined) return;
    const next = waiting.shift();
    if (next) next({ value: message, done: false });
    else queue.push(message);
  });
  const close = (): void => {
    if (finished) return;
    finished = true;
    stop();
    while (waiting.length > 0) waiting.shift()?.({ value: undefined, done: true });
  };
  const stream: AsyncIterableIterator<ChanxMessage> & { close(): void } = {
    close,
    next() {
      const message = queue.shift();
      if (message) return Promise.resolve({ value: message, done: false });
      if (finished) return Promise.resolve({ value: undefined, done: true });
      return new Promise(resolve => { waiting.push(resolve); });
    },
    return() {
      close();
      return Promise.resolve({ value: undefined, done: true });
    },
    [Symbol.asyncIterator]() {
      return stream;
    },
  };
  return stream;
}
