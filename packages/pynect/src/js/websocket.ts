/** Browser-compatible Pynect client for a proxy-fronted WebSocket server. */

import { VenvClosedError, VenvStartupError } from './errors';
import { DEFAULT_CALL_TIMEOUT_MS, DEFAULT_STARTUP_TIMEOUT_MS } from './defaults';
import { PROTOCOL_VERSION, RPC_OPERATION, WEBSOCKET_SUBPROTOCOL } from './protocol';
import type { PythonModule } from './python-object';
import { DEFAULT_WEBSOCKET_RPC_FRAME_BYTES } from './rpc-frame';
import { RpcClient } from './rpc-client';
import { WebSocketRpcTransport } from './transport/websocket-rpc';
import { assertSafeInteger } from './utils/validation';

export interface ConnectWebSocketVenvOptions {
  readonly autoClose?: boolean;
  readonly callTimeoutMs?: number;
  readonly maxFrameBytes?: number;
  readonly startupTimeoutMs?: number;
  readonly url: string | URL;
}

export interface WebSocketVenvInfo {
  readonly protocol: number;
  readonly url: string;
}

/** A lazy Python environment reached through Pynect's WebSocket transport. */
export class WebSocketVenv<Modules extends object = object> implements AsyncDisposable {
  readonly #options: ResolvedWebSocketVenvOptions;
  #client: Promise<RpcClient> | undefined;
  #closeRequested = false;
  #started = false;
  #transport: WebSocketRpcTransport | undefined;

  constructor(options: ConnectWebSocketVenvOptions) {
    this.#options = resolveOptions(options);
  }

  get started(): boolean {
    return this.#started;
  }

  get closed(): boolean {
    return this.#closeRequested;
  }

  import<Name extends keyof Modules & string>(name: Name): Promise<Modules[Name]>;
  import(name: string): Promise<PythonModule>;
  async import(name: string): Promise<unknown> {
    if (!name.trim()) throw new TypeError('Python module name cannot be empty.');
    const client = await this.#start();
    return client.request(RPC_OPERATION.import, { name });
  }

  async ready(): Promise<WebSocketVenvInfo> {
    await this.#start();
    return Object.freeze({
      protocol: PROTOCOL_VERSION,
      url: this.#options.url,
    });
  }

  async close(): Promise<void> {
    if (this.#closeRequested) return;
    this.#closeRequested = true;
    const client = this.#client;
    if (!client) return;
    try {
      await (await client).close();
    } catch {
      this.#transport?.destroy();
    } finally {
      this.#started = false;
    }
  }

  forceClose(): void {
    if (this.#closeRequested) return;
    this.#closeRequested = true;
    this.#started = false;
    this.#transport?.destroy();
    void this.#client?.then(client => client.forceClose()).catch(() => undefined);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  #start(): Promise<RpcClient> {
    if (this.#closeRequested) return Promise.reject(new VenvClosedError());
    if (this.#client) return this.#client;
    const transport = new WebSocketRpcTransport(this.#options.url, WEBSOCKET_SUBPROTOCOL);
    this.#transport = transport;
    const attempt = RpcClient.connect({
      autoUnref: this.#options.autoClose,
      callTimeoutMs: this.#options.callTimeoutMs,
      maxFrameBytes: this.#options.maxFrameBytes,
      timeoutMs: this.#options.startupTimeoutMs,
      transport,
    }).then(async client => {
      if (this.#closeRequested) {
        await client.close();
        throw new VenvClosedError();
      }
      this.#started = true;
      return client;
    }).catch(error => {
      transport.destroy();
      if (this.#client === attempt) this.#client = undefined;
      if (error instanceof VenvClosedError) throw error;
      throw new VenvStartupError('Could not connect to the Pynect WebSocket server.', {
        cause: error,
      });
    });
    this.#client = attempt;
    return attempt;
  }
}

export function connectVenv<Modules extends object = object>(
  options: ConnectWebSocketVenvOptions,
): WebSocketVenv<Modules> {
  return new WebSocketVenv<Modules>(options);
}

interface ResolvedWebSocketVenvOptions {
  readonly autoClose: boolean;
  readonly callTimeoutMs: number;
  readonly maxFrameBytes: number;
  readonly startupTimeoutMs: number;
  readonly url: string;
}

function resolveOptions(options: ConnectWebSocketVenvOptions): ResolvedWebSocketVenvOptions {
  const url = new URL(options.url);
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new TypeError('Pynect WebSocket URLs must use ws: or wss:.');
  }
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_WEBSOCKET_RPC_FRAME_BYTES;
  assertSafeInteger('startupTimeoutMs', startupTimeoutMs, 1);
  assertSafeInteger('callTimeoutMs', callTimeoutMs, 0);
  assertSafeInteger('maxFrameBytes', maxFrameBytes, 1);
  return Object.freeze({
    autoClose: options.autoClose ?? true,
    callTimeoutMs,
    maxFrameBytes,
    startupTimeoutMs,
    url: url.href,
  });
}
