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
type AnyStreamMap = Readonly<Record<string, readonly string[]>>;

export interface PynectStreamDefinition<
  Descriptor extends AnyChannel = AnyChannel,
  Streams extends AnyStreamMap = AnyStreamMap,
> {
  readonly descriptor: Descriptor;
  readonly streams: Streams;
}

type ActionOf<Descriptor extends AnyChannel> = ToServerOf<Descriptor>['action'];

type StreamActionsForDefinition<Definition, Descriptor> =
  Definition extends PynectStreamDefinition<infer DefinedDescriptor, infer Streams>
    ? Descriptor extends DefinedDescriptor ? Extract<keyof Streams, string> : never
    : never;

type StreamActionsFor<
  Definitions extends readonly PynectStreamDefinition[],
  Descriptor,
> = StreamActionsForDefinition<Definitions[number], Descriptor>;

type RequestResult<
  Descriptor extends AnyChannel,
  StreamActions extends string,
  Action extends ActionOf<Descriptor>,
> = Action extends StreamActions
  ? AsyncIterableIterator<ReplyOf<RepliesOf<Descriptor>, Action>>
  : Promise<ReplyOf<RepliesOf<Descriptor>, Action>>;

export type PynectConnection<
  Descriptor extends AnyChannel,
  StreamActions extends string = never,
> = Omit<
  ChannelConnection<ToServerOf<Descriptor>, ToClientOf<Descriptor>, RepliesOf<Descriptor>>,
  'request'
> & {
  request<Action extends ActionOf<Descriptor>>(
    message: ToServerOf<Descriptor> & { readonly action: Action },
    options?: RequestOptions,
  ): RequestResult<Descriptor, StreamActions, Action>;
};

export type PynectClient<Definitions extends readonly PynectStreamDefinition[]> = Omit<
  ChanxClient,
  'connect'
> & {
  connect<Descriptor extends AnyChannel>(
    descriptor: Descriptor,
    options?: ConnectOptions<AddressOf<Descriptor>>,
  ): PynectConnection<Descriptor, StreamActionsFor<Definitions, Descriptor>>;
};

/** Associate generated stream actions and their accepted response actions with a channel. */
export function defineStreamActions<
  Descriptor extends AnyChannel,
  const Streams extends AnyStreamMap,
>(
  descriptor: Descriptor,
  streams: Streams,
): PynectStreamDefinition<Descriptor, Streams> {
  return Object.freeze({ descriptor, streams });
}

/** Wrap Chanx so streamable request actions return ref-correlated async iterators. */
export function createPynectClient<
  const Definitions extends readonly PynectStreamDefinition[],
>(
  options: ClientOptions = {},
  definitions: Definitions,
): PynectClient<Definitions> {
  const client = createChanxClient(options);
  return {
    ...client,
    connect<Descriptor extends AnyChannel>(
      descriptor: Descriptor,
      connectOptions: ConnectOptions<AddressOf<Descriptor>> = {},
    ) {
      const definition = definitions.find(candidate => candidate.descriptor === descriptor);
      if (!definition) return client.connect(descriptor, connectOptions);

      const sharedOptions = { ...connectOptions, share: true };
      const connection = client.connect(descriptor, sharedOptions);
      return new Proxy(connection, {
        get(target, property) {
          if (property === 'request') {
            return (message: ChanxMessage, requestOptions?: RequestOptions) => {
              const responseActions = definition.streams[message.action];
              if (!responseActions) {
                const runtimeConnection = target as unknown as ChannelConnection<
                  ChanxMessage,
                  ChanxMessage,
                  any
                >;
                return runtimeConnection.request(message, requestOptions);
              }
              const streamConnection = client.connect(descriptor, sharedOptions);
              return requestStream(
                streamConnection,
                message,
                new Set(responseActions),
                requestOptions,
              );
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  } as unknown as PynectClient<Definitions>;
}

async function* requestStream(
  connection: ChannelConnection<ChanxMessage, ChanxMessage, any>,
  message: ChanxMessage,
  responseActions: ReadonlySet<string>,
  options?: RequestOptions,
): AsyncGenerator<ChanxMessage> {
  const responses = connection.stream();
  let failure: ChanxRequestError | undefined;
  const stopComplete = connection.onComplete(() => { responses.close(); });
  const stopError = connection.onError(frame => {
    failure = new ChanxRequestError(frame);
    responses.close();
  });
  try {
    const first = await connection.request(message, options) as ChanxMessage;
    if (first.action === 'complete') return;
    if (responseActions.has(first.action)) yield first;
    for await (const response of responses) {
      if (responseActions.has(response.action)) yield response;
    }
    if (failure) throw failure;
  } finally {
    stopComplete();
    stopError();
    responses.close();
    connection.close();
  }
}
