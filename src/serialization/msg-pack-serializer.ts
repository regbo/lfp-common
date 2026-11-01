/**
 * pynect - MsgPackSerializer
 * MessagePack encoder/decoder for high-performance binary serialization.
 * Used for large arrays, complex objects, and bulk data transfer.
 */

import * as msgpack from '@msgpack/msgpack';
import { Logger } from '../utils/logger';

const logger = new Logger('MsgPackSerializer');

/**
 * Extension type definitions for custom Python types.
 * Extension type 1 = Python datetime
 * Extension type 2 = Python complex number
 * Extension type 3 = Python set
 * Extension type 4 = Python tuple
 * Extension type 5 = Python bytes
 */
enum MsgPackExtType {
  DATETIME = 1,
  COMPLEX = 2,
  SET = 3,
  TUPLE = 4,
  BYTES = 5,
  NUMPY_DTYPE = 10,
}

/**
 * MsgPackSerializer - encodes/decodes JavaScript <-> MessagePack binary.
 *
 * Handles Python-specific types via extension codecs:
 * - Python datetime -> JS Date
 * - Python set -> JS Set
 * - Python tuple -> JS Array (immutable semantics lost, acceptable)
 * - Python bytes -> JS Uint8Array
 * - Python complex -> JS {real, imag}
 *
 * @example
 * ```typescript
 * const serializer = new MsgPackSerializer();
 * const encoded = serializer.encode({ key: 'value', nums: [1, 2, 3] });
 * const decoded = serializer.decode(encoded);
 * ```
 */
export class MsgPackSerializer {
  private readonly _encoderOptions: msgpack.EncoderOptions;
  private readonly _decoderOptions: msgpack.DecoderOptions;

  constructor() {
    this._encoderOptions = {
      extensionCodec: this._createExtensionCodec(),
      forceIntegerToFloat: false,
      forceFloat32: false,
      sortKeys: false,
      maxDepth: 64,
    };

    this._decoderOptions = {
      extensionCodec: this._createExtensionCodec(),
      // rawBinaryType: 'Uint8Array',

      useBigInt64: false,
    };
  }

  /**
   * Encode a JavaScript value to MessagePack binary.
   */
  encode(value: unknown): Uint8Array {
    try {
      return msgpack.encode(value, this._encoderOptions);
    } catch (err) {
      logger.error('MsgPack encoding failed', err);
      // Fallback: try encoding as JSON string
      try {
        const json = JSON.stringify(value);
        return msgpack.encode(json, this._encoderOptions);
      } catch {
        // Last resort: empty bytes
        return new Uint8Array(0);
      }
    }
  }

  /**
   * Decode a MessagePack binary to a JavaScript value.
   */
  decode(data: Uint8Array): unknown {
    if (!data || data.length === 0) {return null;}
    try {
      return msgpack.decode(data, this._decoderOptions);
    } catch (err) {
      logger.error('MsgPack decoding failed', err);
      return null;
    }
  }

  /**
   * Encode a stream of values (for streaming large datasets).
   */
  encodeStream(values: Iterable<unknown>): Uint8Array {
    const chunks: Uint8Array[] = [];
    let totalLength = 0;

    for (const value of values) {
      const encoded = this.encode(value);
      chunks.push(encoded);
      totalLength += encoded.length;
    }

    // Concatenate all chunks
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return result;
  }

  /**
   * Decode a stream of values from MessagePack binary.
   */
  *decodeStream(data: Uint8Array): Iterable<unknown> {
    if (!data || data.length === 0) {return;}

    try {
      for (const item of msgpack.decodeMulti(data, this._decoderOptions)) {
        yield item;
      }
    } catch (err) {
      logger.error('MsgPack stream decoding failed', err);
    }
  }

  // Extension Codec

  private _createExtensionCodec(): msgpack.ExtensionCodec {
    const codec = new msgpack.ExtensionCodec();

    // Python datetime -> JS Date
    codec.register({
      type: MsgPackExtType.DATETIME,
      encode: (value: unknown): Uint8Array | null => {
        if (value instanceof Date) {
          const ms = value.getTime();
          const buf = new ArrayBuffer(8);
          new DataView(buf).setFloat64(0, ms, false);
          return new Uint8Array(buf);
        }
        return null;
      },
      decode: (data: Uint8Array): Date => {
        const ms = new DataView(data.buffer, data.byteOffset, data.byteLength).getFloat64(0, false);
        return new Date(ms);
      },
    });

    // Python complex -> {real, imag}
    codec.register({
      type: MsgPackExtType.COMPLEX,
      encode: (value: unknown): Uint8Array | null => {
        if (
          value !== null &&
          typeof value === 'object' &&
          'real' in (value as Record<string, unknown>) &&
          'imag' in (value as Record<string, unknown>)
        ) {
          const buf = new ArrayBuffer(16);
          const dv = new DataView(buf);
          dv.setFloat64(0, (value as { real: number }).real, false);
          dv.setFloat64(8, (value as { imag: number }).imag, false);
          return new Uint8Array(buf);
        }
        return null;
      },
      decode: (data: Uint8Array): { real: number; imag: number } => {
        const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
        return {
          real: dv.getFloat64(0, false),
          imag: dv.getFloat64(8, false),
        };
      },
    });

    // Python set -> JS Set
    codec.register({
      type: MsgPackExtType.SET,
      encode: (value: unknown): Uint8Array | null => {
        if (value instanceof Set) {
          const arr = Array.from(value);
          return this.encode(arr);
        }
        return null;
      },
      decode: (data: Uint8Array): Set<unknown> => {
        const arr = this.decode(data) as unknown[];
        return new Set(arr);
      },
    });

    // Python tuple -> JS Array
    codec.register({
      type: MsgPackExtType.TUPLE,
      encode: (_value: unknown): Uint8Array | null => {
        // Tuples are encoded as arrays by Python side
        return null;
      },
      decode: (data: Uint8Array): unknown[] => {
        const decoded = this.decode(data);
        return Array.isArray(decoded) ? decoded : [decoded];
      },
    });

    return codec;
  }
}
