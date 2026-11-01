/**
 * pynect - Serializer
 * Central coordinator for Python <-> JavaScript data conversion.
 * Routes to specialized bridges (MsgPack, NumPy, DataFrame) based on format.
 */

import type {
  SerializedValue,
  SerializedFormat,
} from '../types/python';
import { NumpyBridge } from './numpy-bridge';
import { DataFrameBridge } from './data-frame-bridge';
import { MsgPackSerializer } from './msg-pack-serializer';
import { Logger } from '../utils/logger';

const logger = new Logger('Serializer');

/**
 * SerializerOptions - controls serialization behavior.
 */
export interface SerializerOptions {
  /** Use SharedArrayBuffer for large NumPy arrays (requires cross-origin isolation) */
  useSharedArrayBuffer?: boolean;
  /** Maximum size for inline JSON (bytes). Larger -> binary */
  maxJsonSize?: number;
  /** Whether to wrap Python objects in PyProxy */
  wrapPythonRefs?: boolean;
}

/**
 * Serializer - converts between Python wire format and JavaScript values.
 *
 * This is a singleton accessed via `Serializer.getInstance()`.
 *
 * @example
 * ```typescript
 * const serializer = Serializer.getInstance();
 *
 * // JavaScript -> Python wire format
 * const sv = await serializer.serialize([1, 2, 3, 4, 5]);
 *
 * // Python wire format -> JavaScript
 * const jsValue = await serializer.deserialize(sv);
 * ```
 */
export class Serializer {
  private static _instance: Serializer | null = null;
  private readonly _options: Required<SerializerOptions>;
  private readonly _numpyBridge: NumpyBridge;
  private readonly _dataframeBridge: DataFrameBridge;
  private readonly _msgpackSerializer: MsgPackSerializer;

  private constructor(options: SerializerOptions = {}) {
    this._options = {
      useSharedArrayBuffer: options.useSharedArrayBuffer ?? false,
      maxJsonSize: options.maxJsonSize ?? 65536,  // 64KB
      wrapPythonRefs: options.wrapPythonRefs ?? true,
    };
    this._numpyBridge = new NumpyBridge({ useSharedArrayBuffer: this._options.useSharedArrayBuffer });
    this._dataframeBridge = new DataFrameBridge();
    this._msgpackSerializer = new MsgPackSerializer();
  }

  static getInstance(options?: SerializerOptions): Serializer {
    if (!Serializer._instance) {
      Serializer._instance = new Serializer(options);
    }
    return Serializer._instance;
  }

  static resetInstance(): void {
    Serializer._instance = null;
  }

  // Python Wire Format -> JavaScript

  /**
   * Deserialize a Python wire format value to JavaScript.
   *
   * Format routing:
   * - JSON (0) -> JSON.parse
   * - MsgPack (1) -> MessagePack decode
   * - NumPy array (2) -> TypedArray
   * - DataFrame (3) -> DataFrameResult
   * - Series (4) -> SeriesResult
   * - PyRef (6) -> PyProxy (via addon)
   * - Bytes (7) -> Uint8Array
   * - None (8) -> null
   */
  async deserialize(sv: SerializedValue): Promise<unknown> {
    const format = sv.format as number;

    switch (format) {
      case 0: // JSON
        return this._deserializeJson(sv);

      case 1: // MSGPACK
        return this._deserializeMsgPack(sv);

      case 2: // NUMPY_ARRAY
        return this._numpyBridge.deserialize(sv);

      case 3: // PANDAS_DATAFRAME
        return this._dataframeBridge.deserializeDataFrame(sv);

      case 4: // PANDAS_SERIES
        return this._dataframeBridge.deserializeSeries(sv);

      case 6: // PYTHON_REF
        return this._deserializePythonRef(sv);

      case 7: // BYTES
        return this._deserializeBytes(sv);

      case 8: // NONE
        return null;

      default:
        logger.warn(`Unknown serialization format: ${format}`);
        return null;
    }
  }

  /**
   * Deserialize synchronously (for non-async contexts).
   * Limited: only works for simple types.
   */
  deserializeSync(sv: SerializedValue): unknown {
    const format = sv.format as number;

    switch (format) {
      case 0: // JSON
        return this._deserializeJson(sv);

      case 7: // BYTES
        return sv.data instanceof Uint8Array ? sv.data : null;

      case 8: // NONE
        return null;

      default:
        // For binary formats, return null in sync mode
        return null;
    }
  }

  // JavaScript -> Python Wire Format

  /**
   * Serialize a JavaScript value to Python wire format.
   * Chooses the most efficient encoding automatically.
   */
  async serialize(value: unknown): Promise<SerializedValue> {
    return this._serializeValue(value);
  }

  /**
   * Serialize synchronously (for non-async contexts).
   */
  serializeSync(value: unknown): SerializedValue {
    return this._serializeValueSync(value);
  }

  // Private Deserialization

  private _deserializeJson(sv: SerializedValue): unknown {
    const data = sv.data;
    if (data === null || data === undefined) {return null;}

    const jsonStr = typeof data === 'string' ? data : new TextDecoder().decode(data as Uint8Array);

    if (!jsonStr || jsonStr === 'null') {return null;}
    if (jsonStr === 'true') {return true;}
    if (jsonStr === 'false') {return false;}

    try {
      return JSON.parse(jsonStr);
    } catch {
      // If JSON parse fails, return the raw string
      return jsonStr;
    }
  }

  private _deserializeMsgPack(sv: SerializedValue): unknown {
    const data = sv.data;
    if (!data || !(data instanceof Uint8Array)) {return null;}
    try {
      return this._msgpackSerializer.decode(data);
    } catch (err) {
      logger.warn('MsgPack deserialization failed', err);
      return null;
    }
  }

  private _deserializePythonRef(sv: SerializedValue): unknown {
    // PyRef deserialization is handled by PyProxy._deserializeAddonResult
    // which has access to the addon. Here we return the raw ref.
    const objectId = sv.metadata?.objectId;
    if (objectId) {
      return { __pyref__: objectId };
    }
    return null;
  }

  private _deserializeBytes(sv: SerializedValue): Uint8Array | null {
    const data = sv.data;
    if (!data) {return null;}
    if (data instanceof Uint8Array) {return data;}
    if (typeof data === 'string') {
      return new TextEncoder().encode(data);
    }
    return null;
  }

  // Private Serialization

  private async _serializeValue(value: unknown): Promise<SerializedValue> {
    return this._serializeValueSync(value);
  }

  private _serializeValueSync(value: unknown): SerializedValue {
    // null / undefined
    if (value === null || value === undefined) {
      return { format: 0 as unknown as SerializedFormat, data: 'null', metadata: {} };
    }

    // Boolean
    if (typeof value === 'boolean') {
      return { format: 0 as unknown as SerializedFormat, data: String(value), metadata: {} };
    }

    // Number
    if (typeof value === 'number') {
      if (Number.isNaN(value)) {
        return { format: 0 as unknown as SerializedFormat, data: 'null', metadata: {} };
      }
      return { format: 0 as unknown as SerializedFormat, data: String(value), metadata: {} };
    }

    // BigInt
    if (typeof value === 'bigint') {
      return { format: 0 as unknown as SerializedFormat, data: `"${value.toString()}"`, metadata: {} };
    }

    // String
    if (typeof value === 'string') {
      return { format: 0 as unknown as SerializedFormat, data: JSON.stringify(value), metadata: {} };
    }

    // TypedArrays -> NumPy format
    if (value instanceof Float32Array) {
      return this._numpyBridge.serializeTypedArray(value, 'float32');
    }
    if (value instanceof Float64Array) {
      return this._numpyBridge.serializeTypedArray(value, 'float64');
    }
    if (value instanceof Int8Array) {
      return this._numpyBridge.serializeTypedArray(value, 'int8');
    }
    if (value instanceof Int16Array) {
      return this._numpyBridge.serializeTypedArray(value, 'int16');
    }
    if (value instanceof Int32Array) {
      return this._numpyBridge.serializeTypedArray(value, 'int32');
    }
    if (value instanceof BigInt64Array) {
      return this._numpyBridge.serializeTypedArray(value, 'int64');
    }
    if (value instanceof Uint8Array) {
      return this._numpyBridge.serializeTypedArray(value, 'uint8');
    }
    if (value instanceof Uint16Array) {
      return this._numpyBridge.serializeTypedArray(value, 'uint16');
    }
    if (value instanceof Uint32Array) {
      return this._numpyBridge.serializeTypedArray(value, 'uint32');
    }
    if (value instanceof BigUint64Array) {
      return this._numpyBridge.serializeTypedArray(value, 'uint64');
    }

    // Raw ArrayBuffer
    if (value instanceof ArrayBuffer) {
      return { format: 7 as unknown as SerializedFormat, data: new Uint8Array(value), metadata: {} };
    }

    // Array - use MsgPack for large, JSON for small
    if (Array.isArray(value)) {
      try {
        const json = JSON.stringify(value);
        if (json.length <= this._options.maxJsonSize) {
          return { format: 0 as unknown as SerializedFormat, data: json, metadata: { length: value.length } };
        }
        // Large array -> MessagePack
        const packed = this._msgpackSerializer.encode(value);
        return { format: 1 as unknown as SerializedFormat, data: packed, metadata: { length: value.length } };
      } catch {
        return { format: 8 as unknown as SerializedFormat, data: null, metadata: {} };
      }
    }

    // Plain object - JSON or MsgPack
    if (typeof value === 'object') {
      try {
        const json = JSON.stringify(value);
        if (json.length <= this._options.maxJsonSize) {
          return { format: 0 as unknown as SerializedFormat, data: json, metadata: {} };
        }
        const packed = this._msgpackSerializer.encode(value);
        return { format: 1 as unknown as SerializedFormat, data: packed, metadata: {} };
      } catch {
        return { format: 8 as unknown as SerializedFormat, data: null, metadata: {} };
      }
    }

    // Fallback
    return { format: 8 as unknown as SerializedFormat, data: null, metadata: {} };
  }
}
