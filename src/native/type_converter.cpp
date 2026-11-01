/**
 * pynect - Type Converter Implementation
 * Python <-> JavaScript/JSON type conversion with object registry.
 */

#include "type_converter.h"
#include "gil_guard.h"

#include <Python.h>
#include <sstream>
#include <map>
#include <mutex>
#include <atomic>
#include <cassert>
#include <cstring>
#include <algorithm>
#include <stdexcept>

namespace pynect {

// Object Registry (Thread-safe)

struct RegistryEntry {
  PyObject* obj;
  std::atomic<int32_t> refCount{1};

  explicit RegistryEntry(PyObject* o) : obj(o) {}
};

static std::map<uint32_t, RegistryEntry*> g_registry;
static std::mutex g_registryMutex;
static std::atomic<uint32_t> g_nextId{1};

uint32_t TypeConverter::registerObject(PyObject* obj) {
  if (!obj) return 0;

  // GIL must be held by caller
  Py_INCREF(obj);

  uint32_t id = g_nextId.fetch_add(1, std::memory_order_relaxed);

  std::lock_guard<std::mutex> lock(g_registryMutex);
  g_registry.emplace(id, new RegistryEntry(obj));

  return id;
}

PyObject* TypeConverter::getObject(uint32_t id) {
  std::lock_guard<std::mutex> lock(g_registryMutex);
  auto it = g_registry.find(id);
  if (it == g_registry.end()) return nullptr;
  return it->second->obj;
}

void TypeConverter::incRef(uint32_t id) {
  std::lock_guard<std::mutex> lock(g_registryMutex);
  auto it = g_registry.find(id);
  if (it != g_registry.end()) {
    it->second->refCount.fetch_add(1);
  }
}

void TypeConverter::decRef(uint32_t id) {
  RegistryEntry* toDelete = nullptr;
  {
    std::lock_guard<std::mutex> lock(g_registryMutex);
    auto it = g_registry.find(id);
    if (it == g_registry.end()) return;

    int32_t newCount = it->second->refCount.fetch_sub(1) - 1;
    if (newCount <= 0) {
      toDelete = it->second;
      g_registry.erase(it);
    }
  }

  if (toDelete) {
    // Must hold GIL to decref Python object
    GILAcquire gil;
    Py_XDECREF(toDelete->obj);
    delete toDelete;
  }
}

size_t TypeConverter::getRegisteredCount() {
  std::lock_guard<std::mutex> lock(g_registryMutex);
  return g_registry.size();
}

void TypeConverter::clearRegistry() {
  std::map<uint32_t, RegistryEntry*> toDelete;
  {
    std::lock_guard<std::mutex> lock(g_registryMutex);
    toDelete.swap(g_registry);
  }

  // Decref all objects with GIL held
  GILAcquire gil;
  for (auto& [id, entry] : toDelete) {
    Py_XDECREF(entry->obj);
    delete entry;
  }
}

// Type Name

std::string TypeConverter::getTypeName(PyObject* obj) {
  if (!obj) return "NoneType";
  PyObject* type = PyObject_Type(obj);
  if (!type) {
    PyErr_Clear();
    return "unknown";
  }
  PyRef typeRef = PyRef::steal(type);
  PyObject* name = PyObject_GetAttrString(type, "__name__");
  if (!name) {
    PyErr_Clear();
    return "unknown";
  }
  PyRef nameRef = PyRef::steal(name);
  const char* str = PyUnicode_AsUTF8AndSize(name, nullptr);
  if (!str) {
    PyErr_Clear();
    return "unknown";
  }
  return str;
}

std::string TypeConverter::getQualifiedTypeName(PyObject* obj) {
  if (!obj) return "NoneType";
  PyObject* type = PyObject_Type(obj);
  if (!type) {
    PyErr_Clear();
    return "unknown";
  }
  PyRef typeRef = PyRef::steal(type);

  // Try __module__.__qualname__ first
  PyObject* module = PyObject_GetAttrString(type, "__module__");
  PyObject* qualname = PyObject_GetAttrString(type, "__qualname__");
  PyErr_Clear();

  std::string result;
  if (module && PyUnicode_Check(module)) {
    const char* mod = PyUnicode_AsUTF8AndSize(module, nullptr);
    if (mod) {
      result = std::string(mod) + ".";
    }
  }
  if (qualname && PyUnicode_Check(qualname)) {
    const char* qn = PyUnicode_AsUTF8AndSize(qualname, nullptr);
    if (qn) result += qn;
  } else {
    result += getTypeName(obj);
  }

  Py_XDECREF(module);
  Py_XDECREF(qualname);
  return result;
}

bool TypeConverter::isCallable(PyObject* obj) {
  return obj && PyCallable_Check(obj);
}

bool TypeConverter::isIterable(PyObject* obj) {
  if (!obj) return false;
  PyObject* iter = PyObject_GetIter(obj);
  if (!iter) {
    PyErr_Clear();
    return false;
  }
  Py_DECREF(iter);
  return true;
}

bool TypeConverter::isAsyncIterable(PyObject* obj) {
  if (!obj) return false;
  // Check for __aiter__ method
  return PyObject_HasAttrString(obj, "__aiter__") == 1;
}

bool TypeConverter::isModule(PyObject* obj) {
  return obj && PyModule_Check(obj);
}

bool TypeConverter::isClass(PyObject* obj) {
  return obj && PyType_Check(obj);
}

// Type Checks (Library-specific)

bool TypeConverter::isNumpyArray(PyObject* obj) {
  if (!obj) return false;
  // Check by type name to avoid hard dependency on numpy C API
  std::string typeName = getQualifiedTypeName(obj);
  return typeName == "numpy.ndarray" || typeName == "numpy.core.multiarray.ndarray";
}

bool TypeConverter::isDataFrame(PyObject* obj) {
  if (!obj) return false;
  std::string typeName = getQualifiedTypeName(obj);
  return typeName == "pandas.core.frame.DataFrame" ||
         typeName.find("DataFrame") != std::string::npos;
}

bool TypeConverter::isSeries(PyObject* obj) {
  if (!obj) return false;
  std::string typeName = getQualifiedTypeName(obj);
  return typeName == "pandas.core.series.Series" ||
         (typeName.find("Series") != std::string::npos &&
          typeName.find("pandas") != std::string::npos);
}

bool TypeConverter::isTorchTensor(PyObject* obj) {
  if (!obj) return false;
  std::string typeName = getQualifiedTypeName(obj);
  return typeName == "torch.Tensor" ||
         typeName == "torch._C._TensorBase";
}

// Python -> SerializedValue

SerializedValue TypeConverter::pythonToSerialized(PyObject* obj, int depth) {
  SerializedValue result;

  if (depth > MAX_DEPTH) {
    // Too deep - register as opaque ref
    result.format = SerializedFormat::PYTHON_REF;
    result.metadata.objectId = registerObject(obj);
    return result;
  }

  // None
  if (obj == Py_None) {
    result.format = SerializedFormat::JSON;
    result.jsonData = "null";
    return result;
  }

  // Bool (must check before int!)
  if (PyBool_Check(obj)) {
    result.format = SerializedFormat::JSON;
    result.jsonData = (obj == Py_True) ? "true" : "false";
    return result;
  }

  // Integer
  if (PyLong_Check(obj)) {
    long long val = PyLong_AsLongLong(obj);
    if (PyErr_Occurred()) {
      PyErr_Clear();
      // Try as unsigned long long
      unsigned long long uval = PyLong_AsUnsignedLongLong(obj);
      if (PyErr_Occurred()) {
        PyErr_Clear();
        // Very large integer - convert to string
        PyObject* strObj = PyObject_Str(obj);
        if (strObj) {
          PyRef strRef = PyRef::steal(strObj);
          result.format = SerializedFormat::JSON;
          result.jsonData = "\"" + std::string(PyUnicode_AsUTF8AndSize(strObj, nullptr)) + "\"";
          return result;
        }
      }
      result.format = SerializedFormat::JSON;
      result.jsonData = std::to_string(uval);
      return result;
    }
    result.format = SerializedFormat::JSON;
    result.jsonData = std::to_string(val);
    return result;
  }

  // Float
  if (PyFloat_Check(obj)) {
    double val = PyFloat_AsDouble(obj);
    if (val != val) {  // NaN
      result.format = SerializedFormat::JSON;
      result.jsonData = "null";  // JSON doesn't have NaN
    } else if (val == std::numeric_limits<double>::infinity()) {
      result.format = SerializedFormat::JSON;
      result.jsonData = "1e308";  // Large number approximation
    } else if (val == -std::numeric_limits<double>::infinity()) {
      result.format = SerializedFormat::JSON;
      result.jsonData = "-1e308";
    } else {
      result.format = SerializedFormat::JSON;
      std::ostringstream oss;
      oss.precision(17);
      oss << val;
      result.jsonData = oss.str();
    }
    return result;
  }

  // String
  if (PyUnicode_Check(obj)) {
    const char* str = PyUnicode_AsUTF8AndSize(obj, nullptr);
    if (!str) {
      PyErr_Clear();
      result.format = SerializedFormat::JSON;
      result.jsonData = "\"\"";
      return result;
    }
    result.format = SerializedFormat::JSON;
    result.jsonData = "\"" + jsonEscape(str) + "\"";
    return result;
  }

  // Bytes
  if (PyBytes_Check(obj)) {
    Py_ssize_t size = PyBytes_Size(obj);
    const char* data = PyBytes_AsString(obj);
    result.format = SerializedFormat::BYTES;
    result.binaryData.assign(data, data + size);
    result.metadata.size_bytes = size;
    return result;
  }

  // Numpy array - check before list/tuple
  if (isNumpyArray(obj)) {
    return numpyArrayToBuffer(obj);
  }

  // Pandas DataFrame
  if (isDataFrame(obj)) {
    return dataFrameToBuffer(obj);
  }

  // Pandas Series
  if (isSeries(obj)) {
    return seriesToBuffer(obj);
  }

  // List - serialize as JSON if small enough
  if (PyList_Check(obj)) {
    Py_ssize_t size = PyList_Size(obj);
    if (size <= static_cast<Py_ssize_t>(MAX_INLINE_SIZE)) {
      result.format = SerializedFormat::JSON;
      result.jsonData = listToJson(obj, depth + 1);
    } else {
      // Large list - serialize as msgpack (fallback to JSON for now)
      result.format = SerializedFormat::JSON;
      result.jsonData = listToJson(obj, depth + 1);
    }
    result.metadata.length = size;
    return result;
  }

  // Tuple
  if (PyTuple_Check(obj)) {
    result.format = SerializedFormat::JSON;
    // Convert tuple to JSON array
    PyObject* list = PySequence_List(obj);
    if (list) {
      PyRef listRef = PyRef::steal(list);
      result.jsonData = listToJson(list, depth + 1);
      result.metadata.length = PyList_Size(list);
    } else {
      PyErr_Clear();
      result.jsonData = "[]";
    }
    return result;
  }

  // Dict
  if (PyDict_Check(obj)) {
    result.format = SerializedFormat::JSON;
    result.jsonData = dictToJson(obj, depth + 1);
    result.metadata.length = PyDict_Size(obj);
    return result;
  }

  // Everything else -> opaque Python reference
  result.format = SerializedFormat::PYTHON_REF;
  result.metadata.objectId = registerObject(obj);
  return result;
}

// Collection serialization

std::string TypeConverter::listToJson(PyObject* seq, int depth) {
  std::ostringstream oss;
  oss << "[";

  Py_ssize_t size = PySequence_Length(seq);
  for (Py_ssize_t i = 0; i < size; ++i) {
    if (i > 0) oss << ",";

    PyObject* item = PySequence_GetItem(seq, i);
    if (!item) {
      PyErr_Clear();
      oss << "null";
      continue;
    }
    PyRef itemRef = PyRef::steal(item);

    SerializedValue sv = pythonToSerialized(item, depth);
    if (sv.format == SerializedFormat::JSON) {
      oss << sv.jsonData;
    } else {
      // Non-JSON item in list - represent as object ref
      oss << "{\"__pyref__\":" << sv.metadata.objectId << "}";
    }
  }

  oss << "]";
  return oss.str();
}

std::string TypeConverter::dictToJson(PyObject* mapping, int depth) {
  std::ostringstream oss;
  oss << "{";

  PyObject* keys = PyMapping_Keys(mapping);
  if (!keys) {
    PyErr_Clear();
    return "{}";
  }
  PyRef keysRef = PyRef::steal(keys);

  Py_ssize_t size = PyList_Size(keys);
  bool first = true;

  for (Py_ssize_t i = 0; i < size; ++i) {
    PyObject* key = PyList_GetItem(keys, i);  // borrowed
    if (!key) continue;

    // Convert key to string
    std::string keyStr;
    if (PyUnicode_Check(key)) {
      const char* k = PyUnicode_AsUTF8AndSize(key, nullptr);
      if (k) keyStr = k;
    } else {
      PyObject* strKey = PyObject_Str(key);
      if (strKey) {
        PyRef strRef = PyRef::steal(strKey);
        const char* k = PyUnicode_AsUTF8AndSize(strKey, nullptr);
        if (k) keyStr = k;
      } else {
        PyErr_Clear();
      }
    }

    PyObject* value = PyObject_GetItem(mapping, key);
    if (!value) {
      PyErr_Clear();
      continue;
    }
    PyRef valueRef = PyRef::steal(value);

    if (!first) oss << ",";
    first = false;

    oss << "\"" << jsonEscape(keyStr) << "\":";

    SerializedValue sv = pythonToSerialized(value, depth);
    if (sv.format == SerializedFormat::JSON) {
      oss << sv.jsonData;
    } else {
      oss << "{\"__pyref__\":" << sv.metadata.objectId << "}";
    }
  }

  oss << "}";
  return oss.str();
}

// Numpy Array Serialization

SerializedValue TypeConverter::numpyArrayToBuffer(PyObject* array) {
  SerializedValue result;
  result.format = SerializedFormat::NUMPY_ARRAY;

  // Get dtype name
  PyObject* dtypeObj = PyObject_GetAttrString(array, "dtype");
  if (dtypeObj) {
    PyRef dtypeRef = PyRef::steal(dtypeObj);
    PyObject* dtypeName = PyObject_GetAttrString(dtypeObj, "name");
    if (dtypeName) {
      PyRef nameRef = PyRef::steal(dtypeName);
      const char* name = PyUnicode_AsUTF8AndSize(dtypeName, nullptr);
      if (name) result.metadata.dtype = name;
    } else { PyErr_Clear(); }
  } else { PyErr_Clear(); }

  // Get shape
  PyObject* shapeObj = PyObject_GetAttrString(array, "shape");
  if (shapeObj) {
    PyRef shapeRef = PyRef::steal(shapeObj);
    Py_ssize_t ndim = PyTuple_Size(shapeObj);
    for (Py_ssize_t i = 0; i < ndim; ++i) {
      PyObject* dim = PyTuple_GetItem(shapeObj, i);
      result.metadata.shape.push_back(PyLong_AsLongLong(dim));
    }
  } else { PyErr_Clear(); }

  // Get the raw data buffer via numpy's tobytes() method
  PyObject* tobytes = PyObject_GetAttrString(array, "tobytes");
  if (tobytes) {
    PyRef tobytesRef = PyRef::steal(tobytes);
    PyObject* bytesObj = PyObject_CallNoArgs(tobytes);
    if (bytesObj) {
      PyRef bytesRef = PyRef::steal(bytesObj);
      char* buffer;
      Py_ssize_t bufLen;
      if (PyBytes_AsStringAndSize(bytesObj, &buffer, &bufLen) == 0) {
        result.binaryData.assign(buffer, buffer + bufLen);
        result.metadata.size_bytes = bufLen;
      } else {
        PyErr_Clear();
      }
    } else { PyErr_Clear(); }
  } else { PyErr_Clear(); }

  // Get contiguity info
  PyObject* flagsObj = PyObject_GetAttrString(array, "flags");
  if (flagsObj) {
    PyRef flagsRef = PyRef::steal(flagsObj);
    PyObject* cContig = PyObject_GetAttrString(flagsObj, "c_contiguous");
    if (cContig) {
      PyRef ccRef = PyRef::steal(cContig);
      result.metadata.isC_contiguous = PyObject_IsTrue(cContig) == 1;
    } else { PyErr_Clear(); }
  } else { PyErr_Clear(); }

  return result;
}

// Pandas DataFrame Serialization

SerializedValue TypeConverter::dataFrameToBuffer(PyObject* df) {
  SerializedValue result;
  result.format = SerializedFormat::PANDAS_DATAFRAME;

  // Get column names
  PyObject* columns = PyObject_GetAttrString(df, "columns");
  if (columns) {
    PyRef colRef = PyRef::steal(columns);
    PyObject* tolist = PyObject_GetAttrString(columns, "tolist");
    if (tolist) {
      PyRef tolistRef = PyRef::steal(tolist);
      PyObject* colList = PyObject_CallNoArgs(tolist);
      if (colList) {
        PyRef colListRef = PyRef::steal(colList);
        Py_ssize_t ncols = PyList_Size(colList);
        for (Py_ssize_t i = 0; i < ncols; ++i) {
          PyObject* col = PyList_GetItem(colList, i);
          if (col && PyUnicode_Check(col)) {
            const char* colName = PyUnicode_AsUTF8AndSize(col, nullptr);
            if (colName) result.metadata.columns.push_back(colName);
          }
        }
      } else { PyErr_Clear(); }
    } else { PyErr_Clear(); }
  } else { PyErr_Clear(); }

  // Serialize to JSON via to_json() for broad compatibility
  // In production, use Arrow format for better performance
  PyObject* toJson = PyObject_GetAttrString(df, "to_json");
  if (toJson) {
    PyRef toJsonRef = PyRef::steal(toJson);

    // Call df.to_json(orient='records')
    PyObject* kwargs = PyDict_New();
    PyObject* orientStr = PyUnicode_FromString("records");
    PyDict_SetItemString(kwargs, "orient", orientStr);
    Py_DECREF(orientStr);

    PyObject* args = PyTuple_New(0);
    PyRef argsRef = PyRef::steal(args);
    PyObject* jsonStr = PyObject_Call(toJson, args, kwargs);
    Py_DECREF(kwargs);

    if (jsonStr) {
      PyRef jsonRef = PyRef::steal(jsonStr);
      const char* json = PyUnicode_AsUTF8AndSize(jsonStr, nullptr);
      if (json) {
        result.jsonData = json;
        result.format = SerializedFormat::PANDAS_DATAFRAME;
      }
    } else { PyErr_Clear(); }
  } else { PyErr_Clear(); }

  return result;
}

// Pandas Series Serialization

SerializedValue TypeConverter::seriesToBuffer(PyObject* series) {
  SerializedValue result;
  result.format = SerializedFormat::PANDAS_SERIES;

  PyObject* toJson = PyObject_GetAttrString(series, "to_json");
  if (toJson) {
    PyRef toJsonRef = PyRef::steal(toJson);
    PyObject* jsonStr = PyObject_CallNoArgs(toJson);
    if (jsonStr) {
      PyRef jsonRef = PyRef::steal(jsonStr);
      const char* json = PyUnicode_AsUTF8AndSize(jsonStr, nullptr);
      if (json) result.jsonData = json;
    } else { PyErr_Clear(); }
  } else { PyErr_Clear(); }

  // Get series name
  PyObject* nameObj = PyObject_GetAttrString(series, "name");
  if (nameObj && nameObj != Py_None) {
    PyRef nameRef = PyRef::steal(nameObj);
    if (PyUnicode_Check(nameObj)) {
      const char* name = PyUnicode_AsUTF8AndSize(nameObj, nullptr);
      if (name) result.metadata.columns.push_back(name);
    }
  } else if (nameObj) {
    Py_DECREF(nameObj);
  }
  PyErr_Clear();

  return result;
}

// JSON Deserialization

PyObject* TypeConverter::jsonToPython(const std::string& json) {
  // Use Python's built-in json module
  PyObject* jsonModule = PyImport_ImportModule("json");
  if (!jsonModule) {
    PyErr_Clear();
    Py_RETURN_NONE;
  }
  PyRef jsonRef = PyRef::steal(jsonModule);

  PyObject* loads = PyObject_GetAttrString(jsonModule, "loads");
  if (!loads) {
    PyErr_Clear();
    Py_RETURN_NONE;
  }
  PyRef loadsRef = PyRef::steal(loads);

  PyObject* strObj = PyUnicode_FromStringAndSize(json.c_str(), json.size());
  if (!strObj) {
    PyErr_Clear();
    Py_RETURN_NONE;
  }
  PyRef strRef = PyRef::steal(strObj);

  PyObject* result = PyObject_CallFunctionObjArgs(loads, strObj, nullptr);
  if (!result) {
    PyErr_Clear();
    Py_RETURN_NONE;
  }

  return result;  // new reference
}

PyObject* TypeConverter::msgpackToPython(const std::vector<uint8_t>& data) {
  // Use msgpack Python library
  PyObject* msgpackModule = PyImport_ImportModule("msgpack");
  if (!msgpackModule) {
    PyErr_Clear();
    // Fallback: treat as bytes
    return PyBytes_FromStringAndSize(
      reinterpret_cast<const char*>(data.data()),
      data.size()
    );
  }
  PyRef mpRef = PyRef::steal(msgpackModule);

  PyObject* unpackb = PyObject_GetAttrString(msgpackModule, "unpackb");
  if (!unpackb) {
    PyErr_Clear();
    return PyBytes_FromStringAndSize(
      reinterpret_cast<const char*>(data.data()),
      data.size()
    );
  }
  PyRef unpackbRef = PyRef::steal(unpackb);

  PyObject* bytesObj = PyBytes_FromStringAndSize(
    reinterpret_cast<const char*>(data.data()),
    data.size()
  );
  if (!bytesObj) return nullptr;
  PyRef bytesRef = PyRef::steal(bytesObj);

  PyObject* kwargs = PyDict_New();
  PyObject* rawFalse = Py_False;
  Py_INCREF(rawFalse);
  PyDict_SetItemString(kwargs, "raw", rawFalse);
  Py_DECREF(rawFalse);

  PyObject* args = PyTuple_Pack(1, bytesObj);
  PyRef argsRef = PyRef::steal(args);
  PyObject* result = PyObject_Call(unpackb, args, kwargs);
  Py_DECREF(kwargs);

  if (!result) {
    PyErr_Clear();
    Py_RETURN_NONE;
  }

  return result;
}

PyObject* TypeConverter::bufferToNumpyArray(
  const std::vector<uint8_t>& data,
  const std::string& dtype,
  const std::vector<int64_t>& shape
) {
  PyObject* np = PyImport_ImportModule("numpy");
  if (!np) {
    PyErr_Clear();
    return nullptr;
  }
  PyRef npRef = PyRef::steal(np);

  PyObject* frombuffer = PyObject_GetAttrString(np, "frombuffer");
  if (!frombuffer) {
    PyErr_Clear();
    return nullptr;
  }
  PyRef frombufferRef = PyRef::steal(frombuffer);

  PyObject* bytesObj = PyBytes_FromStringAndSize(
    reinterpret_cast<const char*>(data.data()),
    data.size()
  );
  if (!bytesObj) return nullptr;
  PyRef bytesRef = PyRef::steal(bytesObj);

  PyObject* dtypeStr = PyUnicode_FromString(dtype.c_str());
  PyRef dtypeRef = PyRef::steal(dtypeStr);

  PyObject* kwargs = PyDict_New();
  PyDict_SetItemString(kwargs, "dtype", dtypeStr);

  PyObject* args = PyTuple_Pack(1, bytesObj);
  PyRef argsRef = PyRef::steal(args);
  PyObject* arr = PyObject_Call(frombuffer, args, kwargs);
  Py_DECREF(kwargs);

  if (!arr) {
    PyErr_Clear();
    return nullptr;
  }
  PyRef arrRef = PyRef::steal(arr);

  // Reshape if needed
  if (shape.size() > 1) {
    PyObject* reshape = PyObject_GetAttrString(arr, "reshape");
    if (reshape) {
      PyRef reshapeRef = PyRef::steal(reshape);

      PyObject* shapeList = PyList_New(shape.size());
      for (size_t i = 0; i < shape.size(); ++i) {
        PyList_SetItem(shapeList, i, PyLong_FromLongLong(shape[i]));
      }
      PyRef shapeListRef = PyRef::steal(shapeList);

      PyObject* reshaped = PyObject_CallFunctionObjArgs(reshape, shapeList, nullptr);
      if (reshaped) {
        return reshaped;
      }
      PyErr_Clear();
    } else {
      PyErr_Clear();
    }
  }

  return arrRef.release();
}

// String / Repr

std::string TypeConverter::getRepr(PyObject* obj) {
  if (!obj) return "<null>";
  PyObject* repr = PyObject_Repr(obj);
  if (!repr) {
    PyErr_Clear();
    return "<error getting repr>";
  }
  PyRef reprRef = PyRef::steal(repr);
  const char* str = PyUnicode_AsUTF8AndSize(repr, nullptr);
  if (!str) {
    PyErr_Clear();
    return "<encoding error>";
  }
  return str;
}

std::string TypeConverter::getStr(PyObject* obj) {
  if (!obj) return "None";
  PyObject* str = PyObject_Str(obj);
  if (!str) {
    PyErr_Clear();
    return "<error>";
  }
  PyRef strRef = PyRef::steal(str);
  const char* cstr = PyUnicode_AsUTF8AndSize(str, nullptr);
  if (!cstr) {
    PyErr_Clear();
    return "";
  }
  return cstr;
}

// Exception Capture

std::tuple<std::string, std::string, std::string> TypeConverter::captureException() {
  std::string typeName, message, traceback;

  PyObject* excType = nullptr;
  PyObject* excValue = nullptr;
  PyObject* excTb = nullptr;

  PyErr_Fetch(&excType, &excValue, &excTb);
  PyErr_NormalizeException(&excType, &excValue, &excTb);

  PyRef typeRef = PyRef::steal(excType);
  PyRef valueRef = PyRef::steal(excValue);
  PyRef tbRef = PyRef::steal(excTb);

  // Get exception type name
  if (excType) {
    PyObject* name = PyObject_GetAttrString(excType, "__name__");
    if (name) {
      PyRef nameRef = PyRef::steal(name);
      const char* n = PyUnicode_AsUTF8AndSize(name, nullptr);
      if (n) typeName = n;
    } else { PyErr_Clear(); }
  }

  // Get exception message
  if (excValue) {
    PyObject* str = PyObject_Str(excValue);
    if (str) {
      PyRef strRef = PyRef::steal(str);
      const char* s = PyUnicode_AsUTF8AndSize(str, nullptr);
      if (s) message = s;
    } else { PyErr_Clear(); }
  }

  // Get traceback
  if (excTb) {
    PyObject* tbModule = PyImport_ImportModule("traceback");
    if (tbModule) {
      PyRef tbModRef = PyRef::steal(tbModule);
      PyObject* formatTb = PyObject_GetAttrString(tbModule, "format_tb");
      if (formatTb) {
        PyRef formatTbRef = PyRef::steal(formatTb);
        PyObject* tbLines = PyObject_CallFunctionObjArgs(formatTb, excTb, nullptr);
        if (tbLines) {
          PyRef tbLinesRef = PyRef::steal(tbLines);
          std::ostringstream oss;
          oss << "Traceback (most recent call last):\n";
          Py_ssize_t nlines = PyList_Size(tbLines);
          for (Py_ssize_t i = 0; i < nlines; ++i) {
            PyObject* line = PyList_GetItem(tbLines, i);
            if (line && PyUnicode_Check(line)) {
              const char* l = PyUnicode_AsUTF8AndSize(line, nullptr);
              if (l) oss << l;
            }
          }
          oss << typeName << ": " << message;
          traceback = oss.str();
        } else { PyErr_Clear(); }
      } else { PyErr_Clear(); }
    } else { PyErr_Clear(); }
  }

  if (traceback.empty()) {
    traceback = typeName + ": " + message;
  }

  return {typeName, message, traceback};
}

std::string TypeConverter::exceptionToJson() {
  auto [type, msg, tb] = captureException();
  std::ostringstream oss;
  oss << "{\"type\":\"" << jsonEscape(type) << "\","
      << "\"message\":\"" << jsonEscape(msg) << "\","
      << "\"traceback\":\"" << jsonEscape(tb) << "\"}";
  return oss.str();
}

// JSON Escape

std::string TypeConverter::jsonEscape(const std::string& s) {
  std::string result;
  result.reserve(s.size() + 16);

  for (unsigned char c : s) {
    switch (c) {
      case '"':  result += "\\\""; break;
      case '\\': result += "\\\\"; break;
      case '\b': result += "\\b"; break;
      case '\f': result += "\\f"; break;
      case '\n': result += "\\n"; break;
      case '\r': result += "\\r"; break;
      case '\t': result += "\\t"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          snprintf(buf, sizeof(buf), "\\u%04x", c);
          result += buf;
        } else {
          result += static_cast<char>(c);
        }
    }
  }

  return result;
}

} // namespace pynect
