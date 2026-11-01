/**
 * pynect - DataFrameBridge
 * Converts Pandas DataFrames and Series to/from JavaScript objects.
 *
 * Wire Protocol
 *
 * DataFrames use the "split" orientation of pandas JSON:
 * {
 * "columns": ["col1", "col2", ...],
 * "data":    [[row0_val0, row0_val1], [row1_val0, row1_val1], ...],
 * "index":   [0, 1, 2, ...],
 * "dtypes":  {"col1": "int64", "col2": "object", ...},
 * "shape":   [nrows, ncols]
 * }
 *
 * For large DataFrames (>64KB) the JSON is embedded in a MessagePack
 * binary to reduce parse overhead.  The format field in SerializedValue
 * tells the bridge which path to take:
 * format === 'pandas_dataframe'  -> DataFrame decode
 * format === 'pandas_series'     -> Series decode
 *
 * Series wire format:
 * {
 * "name":   "my_series",
 * "data":   [1, 2, 3, 4],
 * "index":  [0, 1, 2, 3],
 * "dtype":  "int64",
 * "length": 4
 * }
 *
 * JavaScript representation
 *
 * DataFrameResult (records orientation is built client-side):
 * {
 * columns: string[],
 * data:    Record<string, unknown>[],   <- row objects
 * index:   unknown[],
 * dtypes:  Record<string, string>,
 * shape:   [number, number]
 * }
 *
 * SeriesResult:
 * {
 * name:   string,
 * data:   unknown[],
 * index:  unknown[],
 * dtype:  string,
 * length: number
 * }
 */

import * as msgpack from '@msgpack/msgpack';
import type {
  SerializedValue,
  SerializedFormat,
  DataFrameResult,
  SeriesResult,
} from '../types/python';
import { Logger } from '../utils/Logger';

const logger = new Logger('DataFrameBridge');

// Wire schemas

interface DataFrameWire {
  columns:  string[];
  data:     unknown[][];
  index:    unknown[];
  dtypes?:  Record<string, string>;
  shape?:   [number, number];
}

interface SeriesWire {
  name:    string;
  data:    unknown[];
  index:   unknown[];
  dtype:   string;
  length:  number;
}

// Serialization for JS -> Python

interface DataFrameSerializeOptions {
  /**
   * Row limit when serializing JS -> Python.
   * Excess rows are truncated.  Default: unlimited.
   */
  maxRows?: number;
  /**
   * Use MessagePack instead of JSON for the wire format.
   * Default: true when data size > 64 KB.
   */
  forceMsgPack?: boolean;
}

/**
 * DataFrameBridge - bidirectional conversion for Pandas DataFrames and Series.
 *
 * @example
 * ```typescript
 * const bridge = new DataFrameBridge();
 *
 * // Deserialize a DataFrame received from Python
 * const df: DataFrameResult = bridge.deserializeDataFrame(sv);
 * console.log(df.columns);   // ['city', 'population']
 * console.log(df.data[0]);   // { city: 'Algiers', population: 3500000 }
 *
 * // Serialize a records-array back to Python
 * const sv2 = bridge.serializeDataFrame(df.data, df.columns);
 * ```
 */
export class DataFrameBridge {

  // Deserialization (Python -> JS)

  /**
   * Deserialize a PANDAS_DATAFRAME SerializedValue -> DataFrameResult.
   */
  deserializeDataFrame(sv: SerializedValue): DataFrameResult {
    try {
      const wire = this._decodeWire<DataFrameWire>(sv);
      return this._buildDataFrameResult(wire);
    } catch (err) {
      logger.error('DataFrameBridge.deserializeDataFrame failed', err);
      return { columns: [], data: [], records: [], index: [], dtypes: {}, shape: [0, 0] };
    }
  }

  /**
   * Deserialize a PANDAS_SERIES SerializedValue -> SeriesResult.
   */
  deserializeSeries(sv: SerializedValue): SeriesResult {
    try {
      const wire = this._decodeWire<SeriesWire>(sv);
      return this._buildSeriesResult(wire);
    } catch (err) {
      logger.error('DataFrameBridge.deserializeSeries failed', err);
      return { name: '', data: [], values: [], index: [], dtype: 'object', length: 0 };
    }
  }

  // Serialization (JS -> Python)

  /**
   * Serialize a records-array (array of row objects) into a PANDAS_DATAFRAME
   * SerializedValue that Python can reconstruct with pd.DataFrame(wire).
   *
   * @param records - array of row objects (e.g. [{col1: val1, col2: val2}, ...])
   * @param columns - explicit column order; inferred from first record if omitted
   */
  serializeDataFrame(
    records: Record<string, unknown>[],
    columns?: string[],
    options: DataFrameSerializeOptions = {},
  ): SerializedValue {
    const cols = columns ?? (records[0] ? Object.keys(records[0]) : []);
    const maxRows = options.maxRows;
    const rows = maxRows !== undefined ? records.slice(0, maxRows) : records;

    // Build split-orientation wire object
    const wire: DataFrameWire = {
      columns: cols,
      data:    rows.map(row => cols.map(col => row[col] ?? null)),
      index:   rows.map((_, i) => i),
      dtypes:  {},
      shape:   [rows.length, cols.length],
    };

    return this._encodeWire(wire, 'dataframe', options.forceMsgPack);
  }

  /**
   * Serialize a plain array of values into a PANDAS_SERIES SerializedValue.
   *
   * @param data  - the series values
   * @param name  - series name
   * @param index - optional explicit index
   */
  serializeSeries(
    data: unknown[],
    name: string = '',
    index?: unknown[],
  ): SerializedValue {
    const wire: SeriesWire = {
      name,
      data,
      index: index ?? data.map((_, i) => i),
      dtype: this._inferDtype(data),
      length: data.length,
    };

    return this._encodeWire(wire, 'series');
  }

  // DataFrame transformation helpers

  /**
   * Convert a DataFrameResult to a 2-D array (column-major).
   * Useful for charting libraries.
   */
  static toColumnArrays(
    df: DataFrameResult,
  ): Record<string, unknown[]> {
    const result: Record<string, unknown[]> = {};
    for (const col of df.columns) {
      result[col] = df.data.map(row => row[col]);
    }
    return result;
  }

  /**
   * Convert a DataFrameResult to a 2-D raw array (no column keys).
   * Row-major: result[row][colIndex].
   */
  static toMatrix(df: DataFrameResult): unknown[][] {
    return df.data.map(row => df.columns.map(col => row[col]));
  }

  /**
   * Filter rows of a DataFrameResult.
   */
  static filterRows(
    df: DataFrameResult,
    predicate: (row: Record<string, unknown>, index: unknown) => boolean,
  ): DataFrameResult {
    const filteredData: Record<string, unknown>[] = [];
    const filteredIndex: unknown[] = [];

    for (let i = 0; i < df.data.length; i++) {
      const row = df.data[i]!;
      const idx = df.index[i];
      if (predicate(row, idx)) {
        filteredData.push(row);
        filteredIndex.push(idx);
      }
    }

    return {
      ...df,
      data:    filteredData,
      records: filteredData,
      index:   filteredIndex,
      shape:   [filteredData.length, df.shape[1]],
    };
  }

  /**
   * Select specific columns from a DataFrameResult.
   */
  static selectColumns(df: DataFrameResult, cols: string[]): DataFrameResult {
    const validCols = cols.filter(c => df.columns.includes(c));
    const data = df.data.map(row => Object.fromEntries(validCols.map(c => [c, row[c]])));
    return {
      columns: validCols,
      data,
      records: data,
      index:   df.index,
      dtypes:  Object.fromEntries(validCols.map(c => [c, df.dtypes[c] ?? 'object'])),
      shape:   [df.shape[0], validCols.length],
    };
  }

  /**
   * Compute basic descriptive stats for a numeric column in a DataFrameResult.
   */
  static describeColumn(df: DataFrameResult, col: string): {
    count: number;
    mean: number;
    std: number;
    min: number;
    max: number;
    sum: number;
  } {
    const values = df.data
      .map(row => Number(row[col]))
      .filter(v => Number.isFinite(v));

    const count = values.length;
    if (count === 0) {return { count: 0, mean: 0, std: 0, min: 0, max: 0, sum: 0 };}

    const sum  = values.reduce((a, b) => a + b, 0);
    const mean = sum / count;
    const min  = Math.min(...values);
    const max  = Math.max(...values);
    const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / count;
    const std  = Math.sqrt(variance);

    return { count, mean, std, min, max, sum };
  }

  // Private helpers

  private _decodeWire<T>(sv: SerializedValue): T {
    const data = sv.data;
    if (!data) {throw new Error('SerializedValue.data is null');}

    if (typeof data === 'string') {
      return JSON.parse(data) as T;
    }

    if (data instanceof Uint8Array) {
      // Attempt MessagePack first
      try {
        const decoded = msgpack.decode(data);
        if (decoded && typeof decoded === 'object') {return decoded as T;}
      } catch {
        // Fall through to UTF-8 JSON
      }
      // Try JSON
      const text = new TextDecoder().decode(data);
      return JSON.parse(text) as T;
    }

    throw new Error(`DataFrameBridge: unsupported data type: ${typeof data}`);
  }

  private _encodeWire(
    wire: DataFrameWire | SeriesWire,
    format: 'dataframe' | 'pandas_dataframe' | 'series' | 'pandas_series',
    forceMsgPack?: boolean,
  ): SerializedValue {
    const json = JSON.stringify(wire);
    const useMsgPack = forceMsgPack ?? json.length > 65_536;

    if (useMsgPack) {
      const packed = msgpack.encode(wire);
      return {
        format: format as SerializedFormat,
        data:   packed,
        metadata: {
          length: ('data' in wire) ? wire.data.length : 0,
        },
      };
    }

    return {
      format: format as SerializedFormat,
      data:   json,
      metadata: {
        length: ('data' in wire) ? wire.data.length : 0,
      },
    };
  }

  private _buildDataFrameResult(wire: DataFrameWire): DataFrameResult {
    const columns = wire.columns ?? [];
    const rawData = wire.data    ?? [];
    const index   = wire.index   ?? rawData.map((_, i) => i);
    const dtypes  = wire.dtypes  ?? {};
    const nrows   = rawData.length;
    const ncols   = columns.length;

    // Convert 2-D array -> records
    const records: Record<string, unknown>[] = rawData.map(row => {
      const obj: Record<string, unknown> = {};
      for (let c = 0; c < columns.length; c++) {
        obj[columns[c]!] = row[c] ?? null;
      }
      return obj;
    });

    return {
      columns,
      data:    records,
      records,
      index,
      dtypes,
      shape:   wire.shape ?? [nrows, ncols],
    };
  }

  private _buildSeriesResult(wire: SeriesWire): SeriesResult {
    // Support both 'data' and 'values' as the series values key
    const seriesData: unknown[] = wire.data ?? (wire as unknown as Record<string, unknown[]>)['values'] as unknown[] ?? [];
    return {
      name:   wire.name   ?? '',
      data:   seriesData,
      values: seriesData,
      index:  wire.index  ?? [],
      dtype:  wire.dtype  ?? 'object',
      length: wire.length ?? seriesData.length ?? 0,
    };
  }

  private _inferDtype(data: unknown[]): string {
    if (data.length === 0) {return 'object';}
    const sample = data.find(v => v !== null && v !== undefined);
    if (sample === undefined) {return 'object';}
    if (typeof sample === 'number') {
      return Number.isInteger(sample) ? 'int64' : 'float64';
    }
    if (typeof sample === 'boolean')  {return 'bool';}
    if (typeof sample === 'string')   {return 'object';}
    if (sample instanceof Date)       {return 'datetime64[ns]';}
    return 'object';
  }
}
