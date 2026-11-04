import { createConnection, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { ClientOptions, SocketFactory, WebSocketLike } from '@chanx-js/client';

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

class IpcSocket implements WebSocketLike {
  readyState = CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  readonly #socket: Socket;
  #buffer = '';
  #closeCode = 1000;
  #closeReason = '';

  constructor(
    url: string,
    ipcPath: string,
    protocols?: string | string[],
    headers?: Record<string, string>,
  ) {
    const parsed = new URL(url);
    this.#socket = createConnection(ipcPath);
    this.#socket.setEncoding('utf8');
    this.#socket.on('connect', () => {
      this.#socket.write(`${JSON.stringify({
        path: parsed.pathname,
        query: parsed.search.slice(1),
        subprotocols: typeof protocols === 'string' ? [protocols] : (protocols ?? []),
        ...(headers ? { headers } : {}),
      })}\n`);
      this.readyState = OPEN;
      this.onopen?.({});
    });
    this.#socket.on('data', (chunk: string) => {
      this.#buffer += chunk;
      for (;;) {
        const newline = this.#buffer.indexOf('\n');
        if (newline < 0) break;
        const line = this.#buffer.slice(0, newline).replace(/\r$/u, '');
        this.#buffer = this.#buffer.slice(newline + 1);
        if (line) this.onmessage?.({ data: line });
      }
    });
    this.#socket.on('error', error => this.onerror?.(error));
    this.#socket.on('close', hadError => {
      this.readyState = CLOSED;
      this.onclose?.({
        code: hadError ? 1006 : this.#closeCode,
        reason: this.#closeReason,
      });
    });
  }

  send(data: string): void {
    if (this.readyState !== OPEN) throw new Error('IPC socket is not open.');
    this.#socket.write(`${data}\n`);
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState >= CLOSING) return;
    this.readyState = CLOSING;
    this.#closeCode = code;
    this.#closeReason = reason;
    this.#socket.end();
  }
}

/** Adapt a Unix socket or Windows named pipe to Chanx's `socketFactory`. */
export function createIpcSocketFactory(ipcPath: string): SocketFactory {
  return (url, protocols, options) =>
    new IpcSocket(url, ipcPath, protocols, options?.headers);
}

export function ipcClientOptions(ipcPath: string): ClientOptions {
  return Object.freeze({
    baseUrl: 'ws://pynect-ipc',
    reconnectAttempts: 0,
    socketFactory: createIpcSocketFactory(ipcPath),
  });
}

export function canConnectIpc(ipcPath: string, timeoutMs = 250): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection(ipcPath);
    let settled = false;
    const finish = (connected: boolean): void => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(connected);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

export function defaultIpcPath(name: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\${name}`
    : path.join(os.tmpdir(), `${name}.sock`);
}
