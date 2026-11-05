import { describe, expect, test } from 'bun:test';
import type { ClientOptions } from '@chanx-js/client';
import { PassThrough } from 'node:stream';
import {
  connectModelCatalog,
  listModelsStream,
} from '../../../py/pynect-worker-example/client.js';
import { startExampleWorker } from '../../../py/pynect-worker-example/stdio-worker.js';

describe('generated streams', () => {
  test('correlates concurrent streams over one physical socket', async () => {
    await using worker = await startExampleWorker({ stdout: new PassThrough() });
    const socketFactory = worker.clientOptions.socketFactory;
    if (!socketFactory) throw new Error('stdio client options did not provide a socket factory.');

    let sockets = 0;
    const options: ClientOptions = {
      ...worker.clientOptions,
      socketFactory: (url, protocols, socketOptions) => {
        sockets += 1;
        return socketFactory(url, protocols, socketOptions);
      },
    };

    const connection = connectModelCatalog(options);
    const [first, second] = await Promise.all([
      collect(listModelsStream(connection, { provider: 'openai' })),
      collect(listModelsStream(connection, { provider: 'anthropic' })),
    ]).finally(() => { connection.close(); });

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
