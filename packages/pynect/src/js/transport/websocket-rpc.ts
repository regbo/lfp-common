import { RpcTransportBase } from './rpc-transport';

type RuntimeExtensions = Partial<{
  ref: () => void;
  terminate: () => void;
  unref: () => void;
}>;

/** Adapt the standard browser/Bun WebSocket client to Pynect's byte transport. */
export class WebSocketRpcTransport extends RpcTransportBase {
  readonly #socket: WebSocket;

  constructor(url: string, protocol: string) {
    super();
    this.#socket = new WebSocket(url, protocol);
    this.#socket.binaryType = 'arraybuffer';
    this.#socket.addEventListener('message', event => this.#receive(event.data));
    this.#socket.addEventListener('error', () => {
      this.emitError(new Error('Pynect WebSocket transport failed.'));
    });
    this.#socket.addEventListener('close', () => this.emitClose());
  }

  get closed(): boolean {
    return this.#socket.readyState === WebSocket.CLOSING ||
      this.#socket.readyState === WebSocket.CLOSED;
  }

  send(data: Uint8Array): Promise<void> {
    if (this.#socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Pynect WebSocket is not open.'));
    }
    this.#socket.send(data);
    return Promise.resolve();
  }

  close(): void {
    this.#closeSocket(1000, 'Pynect Venv closed');
  }

  destroy(): void {
    if (this.closed) return;
    const runtime = this.#socket as WebSocket & RuntimeExtensions;
    if (runtime.terminate) runtime.terminate();
    else this.#closeSocket(1011, 'Pynect transport closed');
  }

  ref(): void {
    (this.#socket as WebSocket & RuntimeExtensions).ref?.();
  }

  unref(): void {
    (this.#socket as WebSocket & RuntimeExtensions).unref?.();
  }

  #receive(value: unknown): void {
    if (typeof value === 'string') {
      this.emitError(new TypeError('Pynect WebSocket received a text message.'));
      this.destroy();
      return;
    }
    if (value instanceof ArrayBuffer) {
      this.emitData(new Uint8Array(value));
      return;
    }
    if (ArrayBuffer.isView(value)) {
      this.emitData(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      return;
    }
    if (value instanceof Blob) {
      void value.arrayBuffer().then(
        data => this.emitData(new Uint8Array(data)),
        error => this.emitError(error instanceof Error ? error : new Error(String(error))),
      );
      return;
    }
    this.emitError(new TypeError('Pynect WebSocket received unsupported binary data.'));
    this.destroy();
  }

  #closeSocket(code: number, reason: string): void {
    if (this.closed) return;
    try {
      this.#socket.close(code, reason);
    } catch {
      // Some WebSocket implementations only accept a bare close during connection setup.
      this.#socket.close();
    }
  }
}
