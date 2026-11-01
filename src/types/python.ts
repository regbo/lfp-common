/**
 * pynect - Python Object Type Definitions
 * Core types for representing Python objects in TypeScript.
 */

/**
 * Unique identifier for a Python object in the CPython heap.
 * Stored as a C-level pointer (opaque to JavaScript).
 */
export type PyObjectId = number & { readonly __brand: 'PyObjectId' };

/**
 * Python built-in type names.
 */
export type PyTypeName =
  | 'int'
  | 'float'
  | 'complex'
  | 'bool'
  | 'str'
  | 'bytes'
  | 'bytearray'
  | 'list'
  | 'tuple'
  | 'dict'
  | 'set'
  | 'frozenset'
  | 'NoneType'
  | 'function'
  | 'method'
  | 'builtin_function_or_method'
  | 'module'
  | 'type'
  | 'classmethod'
  | 'staticmethod'
  | 'property'
  | 'generator'
  | 'coroutine'
  | 'async_generator'
  | 'iterator'
  | 'DataFrame'
  | 'Series'
  | 'ndarray'
  | 'Tensor'
  | string;

/**
 * Metadata about a Python object's type.
 */
export interface PyTypeInfo {
  typeName: PyTypeName;
  moduleName?: string;
  qualName?: string;
  isCallable: boolean;
  isIterable: boolean;
  isAsyncIterable: boolean;
  isAwaitable: boolean;
  isClass: boolean;
  isModule: boolean;
  isNone: boolean;
  isPrimitive: boolean;
  isNumeric: boolean;
  isSequence: boolean;
  isMapping: boolean;
}

/**
 * Parameter info from Python function introspection.
 */
export interface PyParamInfo {
  name: string;
  type: string;
  optional: boolean;
  hasDefault: boolean;
  defaultValue?: unknown;
  kind: 'positional_only' | 'positional_or_keyword' | 'var_positional' | 'keyword_only' | 'var_keyword';
}

/**
 * Member/attribute info for a Python class or module.
 */
export interface PyMemberInfo {
  name: string;
  type: string;
  isReadOnly: boolean;
  docstring?: string;
}

/**
 * Full introspection result for a Python callable.
 */
export interface PyCallableInfo {
  name: string;
  qualName: string;
  docstring: string;
  parameters: PyParamInfo[];
  returnType: string;
  isMethod: boolean;
  isClassMethod: boolean;
  isStaticMethod: boolean;
  isCoroutine: boolean;
  isGenerator: boolean;
}

/**
 * Full introspection result for a Python class.
 */
export interface PyClassInfo {
  name: string;
  qualName: string;
  docstring: string;
  bases: string[];
  members: PyMemberInfo[];
  methods: PyCallableInfo[];
  properties: PyMemberInfo[];
  classMethods: PyCallableInfo[];
  staticMethods: PyCallableInfo[];
}

/**
 * Full introspection result for a Python module.
 */
export interface PyModuleInspection {
  name: string;
  file?: string;
  docstring: string;
  version?: string;
  functions: PyCallableInfo[];
  classes: PyClassInfo[];
  constants: PyMemberInfo[];
  submodules: string[];
}

/**
 * Serialized wire format for Python <-> JavaScript data transfer.
 */
export type SerializedFormat =
  | 'json'
  | 'msgpack'
  | 'numpy_array'
  | 'dataframe'
  | 'series'
  | 'pandas_dataframe'
  | 'pandas_series'
  | 'torch_tensor'
  | 'python_ref'
  | 'bytes'
  | 'none'
  | number;   // numeric codes from the C++ addon (9 is a registered JavaScript callback)

export interface SerializedValue {
  format: SerializedFormat;
  data: Uint8Array | string | null | undefined;
  metadata?: SerializedMetadata;
}

export interface SerializedMetadata {
  /** For python_ref: the object ID */
  objectId?: number;
  /** For a registered JavaScript callback. */
  callbackId?: number;
  /** For numpy_array: dtype, shape, strides */
  dtype?: string;
  shape?: number[];
  strides?: number[];
  order?: 'C' | 'F';
  /** For numpy_array: item size in bytes (snake_case variant) */
  itemsize?: number;
  /** For pandas objects: column names, dtypes, index */
  columns?: string[];
  columnDtypes?: string[];
  index?: unknown[];
  indexName?: string;
  /** For pandas: orient (split/records/index/columns/values) */
  orient?: string;
  /** For Series: series name */
  name?: string;
  /** For torch tensors */
  device?: string;
  requiresGrad?: boolean;
  /** General */
  length?: number;
  size?: number;
  itemSize?: number;
}

/**
 * Result from a Python function call.
 */
export interface PyCallResult {
  success: boolean;
  value?: SerializedValue;
  error?: PyErrorInfo;
  objectId?: PyObjectId;
  isObject?: boolean;
}

/**
 * Python exception information.
 */
export interface PyErrorInfo {
  /** Python exception class name, e.g. 'ValueError', 'FileNotFoundError' */
  type: string;
  /** Exception message */
  message: string;
  /** Full Python traceback */
  traceback: string;
  /** Exception module, e.g. 'builtins', 'pandas.errors' */
  module?: string;
  /** Chained exception */
  cause?: PyErrorInfo;
}

/**
 * Iterator state for Python iterators.
 */
export interface PyIteratorState {
  iteratorId: number;
  objectId: PyObjectId;
  done: boolean;
  position: number;
}

/**
 * Result from iterator next() call.
 */
export interface PyIteratorNext {
  done: boolean;
  value?: SerializedValue;
  error?: PyErrorInfo;
}

/**
 * DataFrame representation after deserialization.
 */
export interface DataFrameResult {
  columns: string[];
  /** Row data as array of column-keyed objects */
  data: Record<string, unknown>[];
  /** Alias for data - array of records (row objects) */
  records: Record<string, unknown>[];
  index: unknown[];
  dtypes: Record<string, string>;
  shape: [number, number];
}

/**
 * Series representation after deserialization.
 */
export interface SeriesResult {
  name: string;
  /** Series values */
  data: unknown[];
  /** Alias for data */
  values: unknown[];
  index: unknown[];
  dtype: string;
  length: number;
}

/**
 * A typed array backed by numpy data.
 */
export type NumpyTypedArray =
  | Float32Array
  | Float64Array
  | Int8Array
  | Int16Array
  | Int32Array
  | BigInt64Array
  | Uint8Array
  | Uint16Array
  | Uint32Array
  | BigUint64Array;

/**
 * NumPy array representation after deserialization.
 * Contains the typed array data plus metadata (dtype, shape, ndim).
 */
export interface NumPyArrayResult {
  /** The underlying typed array */
  data: NumpyTypedArray;
  /** NumPy dtype string, e.g. 'float64' */
  dtype: string;
  /** Array shape */
  shape: number[];
  /** Number of dimensions */
  ndim: number;
}

/**
 * Attribute resolution path for lazy Proxy chains.
 */
export type AttributePath = string[];

/**
 * The core PyProxy interface - wraps any Python object.
 * All properties return new PyProxy instances (lazy).
 * Calling the proxy or awaiting it triggers the Python call.
 */
export interface PyProxyInterface {
  readonly _pyObjectId: PyObjectId;
  readonly _path: AttributePath;
  readonly _isResolved: boolean;
  then(
    onfulfilled?: (value: unknown) => unknown,
    onrejected?: (reason: PyErrorInfo) => unknown
  ): Promise<unknown>;
  [key: string]: unknown;
}
