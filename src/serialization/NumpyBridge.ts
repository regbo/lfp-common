/**
 * pynect - NumpyBridge
 * Converts NumPy arrays to/from JavaScript TypedArrays.
 *
 * Wire protocol (binary layout for NUMPY_ARRAY format):
 * Bytes 0-3   : uint32 LE  - ndim (number of dimensions)
 * Bytes 4-7   : uint32 LE  - dtype code (see NumpyDTypeCode)
 * Bytes 8-11  : uint32 LE  - itemsize in bytes
 * Bytes 12-15 : uint32 LE  - total element count
 * Bytes 16..  : ndim x uint32 LE - shape dimensions
 * After shape : raw element bytes (C-contiguous order)
 *
 * When SharedArrayBuffer is enabled the element bytes are placed in a
 * SharedArrayBuffer so the data can be read from Node.js worker threads
 * without copying.
 */

import type { SerializedValue, SerializedFormat, NumPyArrayResult, NumpyTypedArray } from '../types/python';
import { Logger } from '../utils/Logger';

const logger = new Logger('NumpyBridge');

// NumPy dtype codes (must match Python side pynect_runtime.py)

export enum NumpyDTypeCode {
  BOOL    =  0,
  INT8    =  1,
  INT16   =  2,
  INT32   =  3,
  INT64   =  4,
  UINT8   =  5,
  UINT16  =  6,
  UINT32  =  7,
  UINT64  =  8,
  FLOAT32 =  9,
  FLOAT64 = 10,
  COMPLEX64  = 11,
  COMPLEX128 = 12,
}

export type NumpyDType =
  | 'bool'
  | 'int8' | 'int16' | 'int32' | 'int64'
  | 'uint8' | 'uint16' | 'uint32' | 'uint64'
  | 'float32' | 'float64'
  | 'complex64' | 'complex128';

interface NumpyBridgeOptions {
  /**
   * Use SharedArrayBuffer for large arrays.
   * Requires `Cross-Origin-Opener-Policy: same-origin` and
   * `Cross-Origin-Embedder-Policy: require-corp` response headers.
   */
  useSharedArrayBuffer?: boolean;
  /** Threshold in bytes above which SharedArrayBuffer is used. Default: 1 MB */
  sharedArrayBufferThreshold?: number;
}

/** Header size in bytes (see layout above) */
const HEADER_BYTES = 16;

// dtype string -> NumpyDTypeCode

const DTYPE_STRING_TO_CODE: Readonly<Record<NumpyDType, NumpyDTypeCode>> = {
  bool:       NumpyDTypeCode.BOOL,
  int8:       NumpyDTypeCode.INT8,
  int16:      NumpyDTypeCode.INT16,
  int32:      NumpyDTypeCode.INT32,
  int64:      NumpyDTypeCode.INT64,
  uint8:      NumpyDTypeCode.UINT8,
  uint16:     NumpyDTypeCode.UINT16,
  uint32:     NumpyDTypeCode.UINT32,
  uint64:     NumpyDTypeCode.UINT64,
  float32:    NumpyDTypeCode.FLOAT32,
  float64:    NumpyDTypeCode.FLOAT64,
  complex64:  NumpyDTypeCode.COMPLEX64,
  complex128: NumpyDTypeCode.COMPLEX128,
} as const;

// NumpyDTypeCode -> item size in bytes

const DTYPE_CODE_TO_ITEMSIZE: Readonly<Record<NumpyDTypeCode, number>> = {
  [NumpyDTypeCode.BOOL]:       1,
  [NumpyDTypeCode.INT8]:       1,
  [NumpyDTypeCode.INT16]:      2,
  [NumpyDTypeCode.INT32]:      4,
  [NumpyDTypeCode.INT64]:      8,
  [NumpyDTypeCode.UINT8]:      1,
  [NumpyDTypeCode.UINT16]:     2,
  [NumpyDTypeCode.UINT32]:     4,
  [NumpyDTypeCode.UINT64]:     8,
  [NumpyDTypeCode.FLOAT32]:    4,
  [NumpyDTypeCode.FLOAT64]:    8,
  [NumpyDTypeCode.COMPLEX64]:  8,
  [NumpyDTypeCode.COMPLEX128]: 16,
} as const;

/**
 * NumpyBridge - converts NumPy arrays <-> TypedArrays.
 *
 * @example
 * ```typescript
 * const bridge = new NumpyBridge();
 *
 * // Serialize a Float32Array -> NumPy wire format
 * const sv = bridge.serializeTypedArray(new Float32Array([1, 2, 3]), 'float32');
 *
 * // Deserialize NumPy wire format -> TypedArray
 * const arr = bridge.deserialize(sv) as Float32Array;
 * ```
 */
export class NumpyBridge {
  private readonly _useShared: boolean;
  private readonly _sharedThreshold: number;

  constructor(options: NumpyBridgeOptions = {}) {
    this._useShared = options.useSharedArrayBuffer ?? false;
    this._sharedThreshold = options.sharedArrayBufferThreshold ?? 1_048_576; // 1 MB
  }

  // Python wire format -> TypedArray

  /**
   * Deserialize a NUMPY_ARRAY SerializedValue to a TypedArray.
   */
  deserialize(sv: SerializedValue): NumPyArrayResult | null {
    if (sv.format !== 'numpy_array') { return null; }
    const rawData = sv.data;
    if (!rawData) {
      logger.warn('NumpyBridge.deserialize: invalid data');
      return null;
    }

    try {
      let u8: Uint8Array;
      if (typeof rawData === 'string') {
        // base64-encoded binary
        const buf = Buffer.from(rawData, 'base64');
        u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      } else if (rawData instanceof Uint8Array) {
        u8 = rawData;
      } else {
        logger.warn('NumpyBridge.deserialize: unsupported data type');
        return null;
      }
      if (u8.length < HEADER_BYTES) {
        logger.warn('NumpyBridge.deserialize: buffer too small');
        return null;
      }
      return this._decodeBuffer(u8);
    } catch (err) {
      logger.error('NumpyBridge.deserialize failed', err);
      return null;
    }
  }

  // TypedArray -> Python wire format

  /**
   * Serialize a TypedArray to a NUMPY_ARRAY SerializedValue.
   *
   * @param arr    - the typed array
   * @param dtype  - NumPy dtype string
   * @param shape  - optional explicit shape; defaults to [arr.length]
   */
  serializeTypedArray(
    arr: ArrayBufferView,
    dtype: NumpyDType | { dtype: string; itemsize: number },
    shape?: number[],
  ): SerializedValue {
    const dtypeStr: NumpyDType = (typeof dtype === 'string' ? dtype : dtype.dtype) as NumpyDType;
    const dtypeCode = DTYPE_STRING_TO_CODE[dtypeStr] ?? NumpyDTypeCode.FLOAT64;
    const itemSize  = DTYPE_CODE_TO_ITEMSIZE[dtypeCode];
    const dims      = shape ?? [arr.byteLength / itemSize];
    const ndim      = dims.length;
    const count     = dims.reduce((a, b) => a * b, 1);
    const dataBytes = count * itemSize;

    const totalBytes = HEADER_BYTES + ndim * 4 + dataBytes;
    const buffer     = new ArrayBuffer(totalBytes);
    const dv         = new DataView(buffer);
    const u8         = new Uint8Array(buffer);

    // Write header
    dv.setUint32(0,  ndim,     true);
    dv.setUint32(4,  dtypeCode, true);
    dv.setUint32(8,  itemSize,  true);
    dv.setUint32(12, count,     true);

    // Write shape
    for (let i = 0; i < ndim; i++) {
      dv.setUint32(HEADER_BYTES + i * 4, dims[i]!, true);
    }

    // Write data
    const srcU8 = new Uint8Array(
      (arr.buffer as ArrayBuffer),
      arr.byteOffset,
      arr.byteLength,
    );
    u8.set(srcU8, HEADER_BYTES + ndim * 4);

    return {
      format: 'numpy_array' as SerializedFormat,
      data: u8,
      metadata: {
        dtype: dtypeStr,
        shape: dims,
        itemSize,
        size:  dataBytes,
        length: count,
      },
    };
  }

  /**
   * Create an empty NumPy array SerializedValue (used for zero-size results).
   */
  serializeEmpty(dtype: NumpyDType = 'float64'): SerializedValue {
    return this.serializeTypedArray(new Float64Array(0), dtype, [0]);
  }

  // Helpers

  private _decodeBuffer(u8: Uint8Array): NumPyArrayResult {
    const dv       = new DataView((u8.buffer as ArrayBuffer), u8.byteOffset, u8.byteLength);
    const ndim      = dv.getUint32(0,  true);
    const dtypeCode = dv.getUint32(4,  true) as NumpyDTypeCode;
    const itemSize  = dv.getUint32(8,  true);
    const count     = dv.getUint32(12, true);

    // Read shape
    const shape: number[] = [];
    for (let i = 0; i < ndim; i++) {
      shape.push(dv.getUint32(HEADER_BYTES + i * 4, true));
    }

    const dataOffset = HEADER_BYTES + ndim * 4;
    const dataLength = count * itemSize;

    if (u8.length < dataOffset + dataLength) {
      throw new Error(
        `NumpyBridge: buffer too small. ` +
        `Expected ${dataOffset + dataLength} bytes, got ${u8.length}`,
      );
    }

    const srcBuffer = (u8.buffer as ArrayBuffer);
    const srcByteOffset = u8.byteOffset + dataOffset;

    return this._buildTypedArray(dtypeCode, srcBuffer, srcByteOffset, count, shape, ndim);
  }

  private _buildTypedArray(
    code: NumpyDTypeCode,
    srcBuffer: ArrayBuffer,
    byteOffset: number,
    count: number,
    shape: number[] = [],
    ndim: number = 1,
  ): NumPyArrayResult {
    const useShared =
      this._useShared &&
      typeof SharedArrayBuffer !== 'undefined' &&
      count * DTYPE_CODE_TO_ITEMSIZE[code] >= this._sharedThreshold;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const targetBuffer = (useShared
      ? new SharedArrayBuffer(count * DTYPE_CODE_TO_ITEMSIZE[code])
      : new ArrayBuffer(count * DTYPE_CODE_TO_ITEMSIZE[code])) as ArrayBuffer;

    // Copy data
    const src  = new Uint8Array(srcBuffer, byteOffset, count * DTYPE_CODE_TO_ITEMSIZE[code]);
    const dest = new Uint8Array(targetBuffer);
    dest.set(src);

    let data: NumpyTypedArray;
    let dtypeStr: string;
    switch (code) {
      case NumpyDTypeCode.BOOL:
      case NumpyDTypeCode.UINT8:   data = new Uint8Array(targetBuffer);   dtypeStr = code === NumpyDTypeCode.BOOL ? 'bool' : 'uint8'; break;
      case NumpyDTypeCode.INT8:    data = new Int8Array(targetBuffer);    dtypeStr = 'int8'; break;
      case NumpyDTypeCode.INT16:   data = new Int16Array(targetBuffer);   dtypeStr = 'int16'; break;
      case NumpyDTypeCode.INT32:   data = new Int32Array(targetBuffer);   dtypeStr = 'int32'; break;
      case NumpyDTypeCode.INT64:   data = new BigInt64Array(targetBuffer); dtypeStr = 'int64'; break;
      case NumpyDTypeCode.UINT16:  data = new Uint16Array(targetBuffer);  dtypeStr = 'uint16'; break;
      case NumpyDTypeCode.UINT32:  data = new Uint32Array(targetBuffer);  dtypeStr = 'uint32'; break;
      case NumpyDTypeCode.UINT64:  data = new BigUint64Array(targetBuffer); dtypeStr = 'uint64'; break;
      case NumpyDTypeCode.FLOAT32: data = new Float32Array(targetBuffer); dtypeStr = 'float32'; break;
      case NumpyDTypeCode.COMPLEX64:
        data = new Float32Array(targetBuffer); dtypeStr = 'complex64'; break;
      case NumpyDTypeCode.COMPLEX128:
        data = new Float64Array(targetBuffer); dtypeStr = 'complex128'; break;
      case NumpyDTypeCode.FLOAT64:
      default:
        data = new Float64Array(targetBuffer); dtypeStr = 'float64'; break;
    }

    return { data, dtype: dtypeStr, shape, ndim };
  }

  // Static helpers

  /**
   * Detect dtype code from a TypedArray instance.
   */
  static detectDType(arr: ArrayBufferView): { dtype: NumpyDType; itemsize: number } {
    let dtype: NumpyDType;
    if (arr instanceof Float32Array)   { dtype = 'float32'; }
    else if (arr instanceof Float64Array)   { dtype = 'float64'; }
    else if (arr instanceof Int8Array)      { dtype = 'int8'; }
    else if (arr instanceof Int16Array)     { dtype = 'int16'; }
    else if (arr instanceof Int32Array)     { dtype = 'int32'; }
    else if (arr instanceof BigInt64Array)  { dtype = 'int64'; }
    else if (arr instanceof Uint8Array)     { dtype = 'uint8'; }
    else if (arr instanceof Uint16Array)    { dtype = 'uint16'; }
    else if (arr instanceof Uint32Array)    { dtype = 'uint32'; }
    else if (arr instanceof BigUint64Array) { dtype = 'uint64'; }
    else                                    { dtype = 'float64'; }
    const code = DTYPE_STRING_TO_CODE[dtype] ?? NumpyDTypeCode.FLOAT64;
    return { dtype, itemsize: DTYPE_CODE_TO_ITEMSIZE[code] };
  }

  /**
   * Return the item size in bytes for a dtype string.
   */
  static itemSizeOf(dtype: NumpyDType): number {
    const code = DTYPE_STRING_TO_CODE[dtype] ?? NumpyDTypeCode.FLOAT64;
    return DTYPE_CODE_TO_ITEMSIZE[code];
  }
}
