import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createIpcSocketFactory } from '../src/js/ipc.js';

const servers: Server[] = [];
const endpoints: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve());
  })));
  if (process.platform !== 'win32') {
    for (const endpoint of endpoints.splice(0)) rmSync(endpoint, { force: true });
  }
});

describe('Chanx IPC socket adapter', () => {
  test('sends the WebSocket handshake and receives newline-delimited frames', async () => {
    const name = `pynect-test-${process.pid}-${randomUUID()}`;
    const endpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\${name}`
      : path.join(os.tmpdir(), `${name}.sock`);
    endpoints.push(endpoint);
    let handshake: Record<string, unknown> | undefined;
    const server = createServer(socket => {
      socket.setEncoding('utf8');
      let buffer = '';
      socket.on('data', chunk => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        handshake = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
        socket.write('{"action":"ready","payload":null}\n');
      });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(endpoint, resolve);
    });

    const socket = createIpcSocketFactory(endpoint)(
      'ws://pynect-ipc/ws/catalog?scope=all',
      'chanx.v1',
      { headers: { authorization: 'Bearer test' } },
    );
    const message = await new Promise<unknown>((resolve, reject) => {
      socket.onerror = reject;
      socket.onmessage = event => resolve(event.data);
    });

    expect(handshake).toEqual({
      path: '/ws/catalog',
      query: 'scope=all',
      subprotocols: ['chanx.v1'],
      headers: { authorization: 'Bearer test' },
    });
    expect(message).toBe('{"action":"ready","payload":null}');
    socket.close();
  });
});
