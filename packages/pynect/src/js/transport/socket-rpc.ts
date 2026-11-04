import type { Socket } from 'node:net';
import { RpcTransportBase } from './rpc-transport';

/** Adapt a Node socket to the transport-neutral RPC client contract. */
export class SocketRpcTransport extends RpcTransportBase {
  readonly #socket: Socket;

  constructor(socket: Socket) {
    super();
    this.#socket = socket;
    this.#socket.on('data', data => this.emitData(
      typeof data === 'string' ? new TextEncoder().encode(data) : data,
    ));
    this.#socket.once('error', error => this.emitError(error));
    this.#socket.once('close', () => this.emitClose());
  }

  get closed(): boolean {
    return this.#socket.destroyed;
  }

  send(data: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#socket.write(data, error => error ? reject(error) : resolve());
    });
  }

  close(): void {
    this.#socket.end();
  }

  destroy(): void {
    this.#socket.destroy();
  }

  ref(): void {
    this.#socket.ref();
  }

  unref(): void {
    this.#socket.unref();
  }
}
