import { describe, expect, test } from 'bun:test';
import type { ClientOptions } from '@chanx-js/client';
import { PassThrough } from 'node:stream';
import { listModelsStream } from '../example/client.js';
import { startExampleIpcServer } from '../example/ipc-server.js';

describe('generated streams', () => {
  test('correlates concurrent streams over one physical socket', async () => {
    await using server = await startExampleIpcServer({ stdout: new PassThrough() });
    const socketFactory = server.clientOptions.socketFactory;
    if (!socketFactory) throw new Error('IPC client options did not provide a socket factory.');

    let sockets = 0;
    const options: ClientOptions = {
      ...server.clientOptions,
      socketFactory: (url, protocols, socketOptions) => {
        sockets += 1;
        return socketFactory(url, protocols, socketOptions);
      },
    };

    const [first, second] = await Promise.all([
      collect(listModelsStream(options, { provider: 'openai' })),
      collect(listModelsStream(options, { provider: 'anthropic' })),
    ]);

    expect(first.every(model => model.provider === 'openai')).toBe(true);
    expect(second.every(model => model.provider === 'anthropic')).toBe(true);
    expect(first.length + second.length).toBe(8);
    expect(sockets).toBe(1);
  }, 60_000);
});

async function collect<Item>(source: AsyncIterable<Item>): Promise<Item[]> {
  const items: Item[] = [];
  for await (const item of source) items.push(item);
  return items;
}
