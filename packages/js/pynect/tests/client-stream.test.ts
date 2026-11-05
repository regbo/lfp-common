import { describe, expect, test } from 'bun:test';
import {
  ChanxRequestError,
  type ChannelConnection,
  type ChanxMessage,
} from '@chanx-js/client';
import { requestStream } from '../src/client.js';

describe('request streams', () => {
  test('releases listeners and its connection when iteration ends early', async () => {
    const fake = createFakeConnection();
    const stream = requestStream(fake.connection, request());

    expect(await stream.next()).toEqual({
      done: false,
      value: { action: 'item' },
    });
    await stream.return(undefined);

    expect(fake.closeCalls()).toBe(1);
  });

  test('throws a Chanx request error and releases resources after an error frame', async () => {
    const fake = createFakeConnection();
    const stream = requestStream(fake.connection, request());

    await stream.next();
    const next = stream.next();
    fake.fail();

    await expect(next).rejects.toBeInstanceOf(ChanxRequestError);
    expect(fake.closeCalls()).toBe(1);
  });
});

function createFakeConnection() {
  let closeCalls = 0;
  let errorHandler: ((frame: any) => void) | undefined;
  const connection = {
    request: async () => ({ action: 'item' }),
    onAny: () => () => undefined,
    onComplete: () => () => undefined,
    onError: (handler: (frame: any) => void) => {
      errorHandler = handler;
      return () => { errorHandler = undefined; };
    },
    close: () => { closeCalls += 1; },
  } as unknown as ChannelConnection<ChanxMessage, ChanxMessage, any>;

  return {
    connection,
    closeCalls: () => closeCalls,
    fail: () => errorHandler?.({
      action: 'error',
      payload: { detail: 'iteration failed' },
    }),
  };
}

function request(): ChanxMessage {
  return { action: 'stream' };
}
