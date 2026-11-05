import { describe, expect, test } from 'bun:test';
import type { ClientOptions } from '@chanx-js/client';
import { PassThrough } from 'node:stream';
import {
  connectDemo,
  watchWeather,
} from '../../../py/pynect-example/client.js';
import { startExampleWorker } from '../../../py/pynect-example/stdio-worker.js';

describe('generated streams', () => {
  test('correlates concurrent event generators over one physical socket', async () => {
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

    const connection = connectDemo(options);
    const [boston, seattle] = await Promise.all([
      collect(watchWeather(connection, { interval: 0.005, location: 'Boston, MA', updates: 3 })),
      collect(watchWeather(connection, { interval: 0.005, location: 'Seattle, WA', updates: 2 })),
    ]).finally(() => { connection.close(); });

    expect(boston.map(change => change.sequence)).toEqual([1, 2, 3]);
    expect(seattle.map(change => change.sequence)).toEqual([1, 2]);
    expect(boston.every(change => change.weather.location === 'Boston, MA')).toBe(true);
    expect(seattle.every(change => change.weather.location === 'Seattle, WA')).toBe(true);
    expect(sockets).toBe(1);
  }, 60_000);
});

async function collect<Item>(source: AsyncIterable<Item>): Promise<Item[]> {
  const items: Item[] = [];
  for await (const item of source) items.push(item);
  return items;
}
