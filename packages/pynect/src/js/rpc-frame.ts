import { decode, encode } from '@msgpack/msgpack';

export const MAX_LOCAL_RPC_FRAME_BYTES = 256 * 1024 * 1024;
export const DEFAULT_WEBSOCKET_RPC_FRAME_BYTES = 8 * 1024 * 1024;

/** Incrementally split a byte stream into length-prefixed Pynect RPC frames. */
export class RpcFrameDecoder {
  readonly #maxFrameBytes: number;
  #buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  constructor(maxFrameBytes: number) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) {
      throw new TypeError('maxFrameBytes must be a positive safe integer.');
    }
    this.#maxFrameBytes = maxFrameBytes;
  }

  get maxFrameBytes(): number {
    return this.#maxFrameBytes;
  }

  push(data: Uint8Array): Uint8Array[] {
    if (data.byteLength === 0) return [];
    this.#buffer = concatenate(this.#buffer, data);
    const frames: Uint8Array[] = [];
    let offset = 0;
    while (this.#buffer.byteLength - offset >= 4) {
      const view = new DataView(
        this.#buffer.buffer,
        this.#buffer.byteOffset + offset,
        4,
      );
      const length = view.getUint32(0);
      if (length > this.#maxFrameBytes) {
        throw new RangeError(`RPC frame exceeds ${this.#maxFrameBytes} bytes.`);
      }
      const frameLength = length + 4;
      if (this.#buffer.byteLength - offset < frameLength) break;
      frames.push(this.#buffer.slice(offset, offset + frameLength));
      offset += frameLength;
    }
    if (offset > 0) this.#buffer = this.#buffer.slice(offset);
    return frames;
  }

  reset(): void {
    this.#buffer = new Uint8Array(0);
  }
}

export function encodeRpcFrame(
  message: Readonly<Record<string, unknown>>,
  maxFrameBytes: number,
): Uint8Array {
  const payload = encode(message, { useBigInt64: true });
  if (payload.byteLength > maxFrameBytes) {
    throw new RangeError(`RPC frame exceeds ${maxFrameBytes} bytes.`);
  }
  const frame = new Uint8Array(payload.byteLength + 4);
  new DataView(frame.buffer).setUint32(0, payload.byteLength);
  frame.set(payload, 4);
  return frame;
}

export function decodeRpcFrame(frame: Uint8Array): unknown {
  if (frame.byteLength < 4) throw new TypeError('RPC frame is missing its length prefix.');
  const length = new DataView(frame.buffer, frame.byteOffset, 4).getUint32(0);
  if (length !== frame.byteLength - 4) throw new TypeError('RPC frame length is invalid.');
  return decode(frame.subarray(4), { useBigInt64: true });
}

function concatenate(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  if (left.byteLength === 0) return right.slice();
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left);
  combined.set(right, left.byteLength);
  return combined;
}
