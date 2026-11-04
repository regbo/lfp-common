export interface RpcTransportHandlers {
  readonly close: () => void;
  readonly data: (data: Uint8Array) => void;
  readonly error: (error: Error) => void;
}

/** Byte-stream operations required by the Pynect RPC client. */
export interface RpcTransport {
  readonly closed: boolean;
  close(): void;
  destroy(): void;
  ref(): void;
  send(data: Uint8Array): Promise<void>;
  setHandlers(handlers: RpcTransportHandlers): void;
  unref(): void;
}

/** Buffer early transport events until the RPC client installs its handlers. */
export abstract class RpcTransportBase implements RpcTransport {
  readonly #queuedData: Uint8Array[] = [];
  #handlers: RpcTransportHandlers | undefined;
  #queuedError: Error | undefined;
  #queuedClose = false;

  abstract get closed(): boolean;
  abstract close(): void;
  abstract destroy(): void;
  abstract ref(): void;
  abstract send(data: Uint8Array): Promise<void>;
  abstract unref(): void;

  setHandlers(handlers: RpcTransportHandlers): void {
    if (this.#handlers) throw new Error('RPC transport handlers are already registered.');
    this.#handlers = handlers;
    for (const data of this.#queuedData.splice(0)) handlers.data(data);
    if (this.#queuedError) handlers.error(this.#queuedError);
    if (this.#queuedClose) handlers.close();
  }

  protected emitData(data: Uint8Array): void {
    if (this.#handlers) this.#handlers.data(data);
    else this.#queuedData.push(data.slice());
  }

  protected emitError(error: Error): void {
    if (this.#handlers) this.#handlers.error(error);
    else this.#queuedError ??= error;
  }

  protected emitClose(): void {
    if (this.#handlers) this.#handlers.close();
    else this.#queuedClose = true;
  }
}
