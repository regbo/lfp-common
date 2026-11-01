"""
pynect - Python-side serializer
Converts Python objects into the pynect wire format consumed by the
TypeScript DataFrameBridge / NumpyBridge.

Wire format codes (must match numpy-bridge.ts NumpyDTypeCode enum):
  0  bool
  1  int8    2  int16    3  int32    4  int64
  5  uint8   6  uint16   7  uint32   8  uint64
  9  float32  10  float64
  11 complex64  12 complex128

DataFrame / Series are serialised as JSON (split orientation).
NumPy arrays use the custom binary layout described in numpy-bridge.ts.
"""

from __future__ import annotations

import json
import struct
import datetime
from typing import Any, Dict, List, Optional, Tuple, Union

# Optional heavy imports

try:
    import numpy as np
    HAS_NUMPY = True
except ImportError:
    HAS_NUMPY = False

try:
    import pandas as pd
    HAS_PANDAS = True
except ImportError:
    HAS_PANDAS = False

try:
    import msgpack
    HAS_MSGPACK = True
except ImportError:
    HAS_MSGPACK = False

# dtype string -> code

_DTYPE_TO_CODE: Dict[str, int] = {
    'bool':       0,
    'int8':       1,  'int16':  2,  'int32':  3,  'int64':  4,
    'uint8':      5,  'uint16': 6,  'uint32': 7,  'uint64': 8,
    'float32':    9,  'float64': 10,
    'complex64':  11, 'complex128': 12,
}

_NUMPY_DTYPE_MAP: Dict[str, str] = {
    'bool':    'bool',
    'int8':    'int8',    'int16':  'int16',  'int32':  'int32',  'int64':  'int64',
    'uint8':   'uint8',   'uint16': 'uint16', 'uint32': 'uint32', 'uint64': 'uint64',
    'float32': 'float32', 'float64': 'float64',
    'complex64': 'complex64', 'complex128': 'complex128',
}

# SerializedFormat codes (match TypeScript SerializedFormat union)

FORMAT_JSON        = 0
FORMAT_MSGPACK     = 1
FORMAT_NUMPY       = 2
FORMAT_DATAFRAME   = 3
FORMAT_SERIES      = 4
FORMAT_TORCH       = 5
FORMAT_PYTHON_REF  = 6
FORMAT_BYTES       = 7
FORMAT_NONE        = 8


# Public API


def serialize(value: Any, *, prefer_msgpack: bool = False) -> Dict[str, Any]:
    """
    Serialize *value* to a pynect wire-format dict:
      { 'format': int, 'data': bytes|str|None, 'metadata': dict }
    """
    if value is None:
        return _none()

    if isinstance(value, bool):
        return _json(str(value).lower())

    if isinstance(value, int):
        return _json(str(value))

    if isinstance(value, float):
        if value != value:           # NaN
            return _json('null')
        return _json(repr(value))

    if isinstance(value, complex):
        return _json(json.dumps({'real': value.real, 'imag': value.imag}))

    if isinstance(value, str):
        return _json(json.dumps(value))

    if isinstance(value, bytes):
        return {'format': FORMAT_BYTES, 'data': value, 'metadata': {'length': len(value)}}

    if HAS_NUMPY and isinstance(value, np.ndarray):
        return _serialize_ndarray(value)

    if HAS_NUMPY and isinstance(value, np.generic):
        return serialize(value.item())

    if HAS_PANDAS and isinstance(value, pd.DataFrame):
        return _serialize_dataframe(value)

    if HAS_PANDAS and isinstance(value, pd.Series):
        return _serialize_series(value)

    if isinstance(value, (list, tuple)):
        return _serialize_sequence(value, prefer_msgpack=prefer_msgpack)

    if isinstance(value, dict):
        return _serialize_mapping(value, prefer_msgpack=prefer_msgpack)

    if isinstance(value, (datetime.datetime, datetime.date)):
        return _json(json.dumps(value.isoformat()))

    if isinstance(value, set):
        return _serialize_sequence(list(value), prefer_msgpack=prefer_msgpack)

    # Fall through - mark as Python ref so Node side wraps in PyProxy
    return _python_ref(id(value))


def deserialize(wire: Dict[str, Any]) -> Any:
    """
    Deserialize a wire-format dict back to a Python value.
    Used when data flows Node -> Python.
    """
    fmt  = wire.get('format', FORMAT_NONE)
    data = wire.get('data')
    meta = wire.get('metadata') or {}

    if fmt == FORMAT_NONE or data is None:
        return None

    if fmt == FORMAT_JSON:
        return json.loads(data) if data else None

    if fmt == FORMAT_MSGPACK:
        if not HAS_MSGPACK:
            raise RuntimeError('msgpack not installed; cannot deserialize MSGPACK format')
        return msgpack.unpackb(data, raw=False)

    if fmt == FORMAT_NUMPY:
        return _deserialize_ndarray(data)

    if fmt == FORMAT_DATAFRAME:
        return _deserialize_dataframe(data)

    if fmt == FORMAT_SERIES:
        return _deserialize_series(data)

    if fmt == FORMAT_BYTES:
        return data if isinstance(data, (bytes, bytearray)) else data.encode()

    return None


# NumPy helpers


def _serialize_ndarray(arr: 'np.ndarray') -> Dict[str, Any]:
    """Serialize NumPy array using the binary layout in numpy-bridge.ts."""
    dtype_str = _NUMPY_DTYPE_MAP.get(arr.dtype.name, 'float64')
    dtype_code = _DTYPE_TO_CODE.get(dtype_str, 10)
    item_size  = arr.itemsize
    ndim       = arr.ndim
    shape      = list(arr.shape)
    count      = arr.size

    # Ensure C-contiguous
    if not arr.flags['C_CONTIGUOUS']:
        arr = np.ascontiguousarray(arr)

    # Build header: 4xuint32 + ndimxuint32
    header = struct.pack(
        f'<4I{ndim}I',
        ndim, dtype_code, item_size, count,
        *shape,
    )
    data = header + arr.tobytes()

    return {
        'format': FORMAT_NUMPY,
        'data': data,
        'metadata': {
            'dtype': dtype_str,
            'shape': shape,
            'itemSize': item_size,
            'length': count,
        },
    }


def _deserialize_ndarray(data: bytes) -> Optional['np.ndarray']:
    if not HAS_NUMPY:
        return None
    if len(data) < 16:
        return None

    ndim, dtype_code, item_size, count = struct.unpack_from('<4I', data, 0)
    shape = struct.unpack_from(f'<{ndim}I', data, 16)
    data_offset = 16 + ndim * 4

    # Map code -> numpy dtype
    code_to_np = {
        0: 'bool', 1: 'int8', 2: 'int16', 3: 'int32', 4: 'int64',
        5: 'uint8', 6: 'uint16', 7: 'uint32', 8: 'uint64',
        9: 'float32', 10: 'float64', 11: 'complex64', 12: 'complex128',
    }
    np_dtype = code_to_np.get(dtype_code, 'float64')

    raw = data[data_offset: data_offset + count * item_size]
    arr = np.frombuffer(raw, dtype=np.dtype(np_dtype)).reshape(shape)
    return arr.copy()


# Pandas helpers


def _serialize_dataframe(df: 'pd.DataFrame') -> Dict[str, Any]:
    """Serialize DataFrame to split-orientation JSON wire format."""
    columns = [str(c) for c in df.columns.tolist()]
    index   = df.index.tolist()
    dtypes  = {str(k): str(v) for k, v in df.dtypes.to_dict().items()}
    shape   = list(df.shape)

    # Convert rows to lists of native Python types
    data_rows: List[List[Any]] = []
    for _, row in df.iterrows():
        data_rows.append([_to_native(v) for v in row])

    wire = {
        'columns': columns,
        'data':    data_rows,
        'index':   [_to_native(i) for i in index],
        'dtypes':  dtypes,
        'shape':   shape,
    }

    json_str = json.dumps(wire, default=_json_default)
    return {
        'format': FORMAT_DATAFRAME,
        'data': json_str,
        'metadata': {'length': shape[0], 'columns': columns},
    }


def _deserialize_dataframe(data: Union[str, bytes]) -> Optional['pd.DataFrame']:
    if not HAS_PANDAS:
        return None
    text = data.decode() if isinstance(data, (bytes, bytearray)) else data
    wire = json.loads(text)
    columns = wire.get('columns', [])
    rows    = wire.get('data', [])
    index   = wire.get('index', None)
    df = pd.DataFrame(rows, columns=columns, index=index)
    return df


def _serialize_series(s: 'pd.Series') -> Dict[str, Any]:
    wire = {
        'name':   str(s.name) if s.name is not None else '',
        'data':   [_to_native(v) for v in s.tolist()],
        'index':  [_to_native(i) for i in s.index.tolist()],
        'dtype':  str(s.dtype),
        'length': len(s),
    }
    json_str = json.dumps(wire, default=_json_default)
    return {
        'format': FORMAT_SERIES,
        'data': json_str,
        'metadata': {'length': len(s)},
    }


def _deserialize_series(data: Union[str, bytes]) -> Optional['pd.Series']:
    if not HAS_PANDAS:
        return None
    text = data.decode() if isinstance(data, (bytes, bytearray)) else data
    wire = json.loads(text)
    s = pd.Series(wire.get('data', []), index=wire.get('index', None), name=wire.get('name'))
    return s


# Generic helpers


def _serialize_sequence(seq: Union[list, tuple], *, prefer_msgpack: bool) -> Dict[str, Any]:
    try:
        native = [_to_native(v) for v in seq]
        json_str = json.dumps(native, default=_json_default)
        if len(json_str) <= 65_536 and not prefer_msgpack:
            return _json(json_str)
        if HAS_MSGPACK:
            return {'format': FORMAT_MSGPACK, 'data': msgpack.packb(native, use_bin_type=True), 'metadata': {'length': len(seq)}}
        return _json(json_str)
    except Exception:
        return _none()


def _serialize_mapping(mapping: dict, *, prefer_msgpack: bool) -> Dict[str, Any]:
    try:
        native = {str(k): _to_native(v) for k, v in mapping.items()}
        json_str = json.dumps(native, default=_json_default)
        if len(json_str) <= 65_536 and not prefer_msgpack:
            return _json(json_str)
        if HAS_MSGPACK:
            return {'format': FORMAT_MSGPACK, 'data': msgpack.packb(native, use_bin_type=True), 'metadata': {}}
        return _json(json_str)
    except Exception:
        return _none()


# Utility


def _json(text: str) -> Dict[str, Any]:
    return {'format': FORMAT_JSON, 'data': text, 'metadata': {}}


def _none() -> Dict[str, Any]:
    return {'format': FORMAT_NONE, 'data': None, 'metadata': {}}


def _python_ref(obj_id: int) -> Dict[str, Any]:
    return {'format': FORMAT_PYTHON_REF, 'data': None, 'metadata': {'objectId': obj_id}}


def _to_native(value: Any) -> Any:
    """Recursively convert NumPy/Pandas scalars to Python native types."""
    if HAS_NUMPY:
        if isinstance(value, np.integer):
            return int(value)
        if isinstance(value, np.floating):
            return float(value)
        if isinstance(value, np.bool_):
            return bool(value)
        if isinstance(value, np.complexfloating):
            return {'real': float(value.real), 'imag': float(value.imag)}
        if isinstance(value, np.ndarray):
            return value.tolist()
    if HAS_PANDAS:
        if pd.isna(value):
            return None
    if isinstance(value, (datetime.datetime, datetime.date)):
        return value.isoformat()
    return value


def _json_default(obj: Any) -> Any:
    """json.dumps default handler for non-serializable types."""
    if HAS_NUMPY and isinstance(obj, np.integer):
        return int(obj)
    if HAS_NUMPY and isinstance(obj, np.floating):
        return float(obj)
    if HAS_NUMPY and isinstance(obj, np.ndarray):
        return obj.tolist()
    if isinstance(obj, (datetime.datetime, datetime.date)):
        return obj.isoformat()
    if isinstance(obj, bytes):
        return obj.hex()
    raise TypeError(f'Object of type {type(obj).__name__} is not JSON serializable')
