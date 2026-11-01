/**
 * pynect - Type Converter Header
 * Converts between Python objects and JavaScript/JSON representations.
 *
 * Conversion strategy:
 * - Primitive types (int, float, bool, str, None) -> JSON
 * - Large arrays (numpy, lists) -> MessagePack binary
 * - numpy arrays -> binary buffer with metadata
 * - pandas DataFrames -> Arrow/binary with schema metadata
 * - Complex Python objects -> opaque references (PyObjectId)
 */

#pragma once

#include <Python.h>
#include <napi.h>
#include <string>
#include <vector>
#include <cstdint>
#include <optional>

namespace pynect {

/**
 * Wire format identifiers (must match TypeScript SerializedFormat enum)
 */
enum class SerializedFormat : uint8_t {
  JSON = 0,
  MSGPACK = 1,
  NUMPY_ARRAY = 2,
  PANDAS_DATAFRAME = 3,
  PANDAS_SERIES = 4,
  TORCH_TENSOR = 5,
  PYTHON_REF = 6,
  BYTES = 7,
  NONE = 8,
  JS_CALLBACK = 9,
};

/**
 * Metadata for serialized values.
 */
struct SerializedMetadata {
  // For NUMPY_ARRAY
  std::string dtype;
  std::vector<int64_t> shape;
  std::vector<int64_t> strides;
  bool isC_contiguous = true;

  // For PANDAS_DATAFRAME
  std::vector<std::string> columns;
  std::vector<std::string> columnDtypes;

  // For PYTHON_REF
  uint32_t objectId = 0;
  uint32_t callbackId = 0;

  // General
  int64_t length = 0;
  int64_t size_bytes = 0;
};

/**
 * A serialized value ready to be sent to JavaScript.
 */
struct SerializedValue {
  SerializedFormat format = SerializedFormat::NONE;
  std::string jsonData;          // For JSON format
  std::vector<uint8_t> binaryData; // For binary formats
  SerializedMetadata metadata;
};

/**
 * TypeConverter - stateless utility class for Python <-> JavaScript conversions.
 *
 * All methods are static and thread-safe (GIL must be held by caller).
 */
class TypeConverter {
public:
  TypeConverter() = delete;

  // Python -> SerializedValue

  /**
   * Convert any Python object to a SerializedValue for JavaScript consumption.
   * @param obj - Python object (borrowed reference)
   * @param depth - current recursion depth (prevents infinite loops)
   * @returns SerializedValue
   */
  static SerializedValue pythonToSerialized(PyObject* obj, int depth = 0);

  /**
   * Convert Python primitive to JSON string.
   * Returns std::nullopt if obj is not a primitive.
   */
  static std::optional<std::string> primitiveToJson(PyObject* obj);

  /**
   * Convert Python list/tuple to JSON array string.
   */
  static std::string listToJson(PyObject* seq, int depth);

  /**
   * Convert Python dict to JSON object string.
   */
  static std::string dictToJson(PyObject* mapping, int depth);

  /**
   * Serialize numpy ndarray to binary buffer + metadata.
   */
  static SerializedValue numpyArrayToBuffer(PyObject* array);

  /**
   * Serialize pandas DataFrame to binary + metadata.
   */
  static SerializedValue dataFrameToBuffer(PyObject* df);

  /**
   * Serialize pandas Series to binary + metadata.
   */
  static SerializedValue seriesToBuffer(PyObject* series);

  /**
   * Check if a Python object is a numpy array.
   */
  static bool isNumpyArray(PyObject* obj);

  /**
   * Check if a Python object is a pandas DataFrame.
   */
  static bool isDataFrame(PyObject* obj);

  /**
   * Check if a Python object is a pandas Series.
   */
  static bool isSeries(PyObject* obj);

  /**
   * Check if a Python object is a PyTorch Tensor.
   */
  static bool isTorchTensor(PyObject* obj);

  // JavaScript/JSON -> Python

  /**
   * Convert a JSON string to a Python object.
   * @returns new Python reference, or nullptr on error
   */
  static PyObject* jsonToPython(const std::string& json);

  /**
   * Convert a MessagePack binary to a Python object.
   */
  static PyObject* msgpackToPython(const std::vector<uint8_t>& data);

  /**
   * Convert a typed array buffer to a numpy array.
   */
  static PyObject* bufferToNumpyArray(
    const std::vector<uint8_t>& data,
    const std::string& dtype,
    const std::vector<int64_t>& shape
  );

  // Type Inspection

  /**
   * Get the Python type name of an object.
   */
  static std::string getTypeName(PyObject* obj);

  /**
   * Get the full qualified type name (module.class).
   */
  static std::string getQualifiedTypeName(PyObject* obj);

  /**
   * Check if the object is callable.
   */
  static bool isCallable(PyObject* obj);

  /**
   * Check if the object is iterable.
   */
  static bool isIterable(PyObject* obj);

  /**
   * Check if the object is async iterable.
   */
  static bool isAsyncIterable(PyObject* obj);

  /**
   * Check if the object is a Python module.
   */
  static bool isModule(PyObject* obj);

  /**
   * Check if the object is a Python class.
   */
  static bool isClass(PyObject* obj);

  /**
   * Get string representation (repr) of an object.
   */
  static std::string getRepr(PyObject* obj);

  /**
   * Get string representation (str) of an object.
   */
  static std::string getStr(PyObject* obj);

  // Error Handling

  /**
   * Capture current Python exception state as strings.
   * Clears the exception after capturing.
   * @returns tuple of (type, message, traceback)
   */
  static std::tuple<std::string, std::string, std::string> captureException();

  /**
   * Convert a Python exception to JSON for transmission to JS.
   */
  static std::string exceptionToJson();

  // Object Registry
  // Python objects that can't be serialized are stored in a registry
  // and referenced by ID from JavaScript.

  /**
   * Register a Python object and return its ID.
   * Increments reference count.
   */
  static uint32_t registerObject(PyObject* obj);

  /**
   * Get a Python object by ID.
   * Returns borrowed reference (do not decref).
   */
  static PyObject* getObject(uint32_t id);

  /**
   * Increment reference count of a registered object.
   */
  static void incRef(uint32_t id);

  /**
   * Decrement reference count of a registered object.
   * If refcount reaches 0, removes from registry.
   */
  static void decRef(uint32_t id);

  /**
   * Get count of registered objects (for monitoring).
   */
  static size_t getRegisteredCount();

  /**
   * Clear all registered objects (during shutdown).
   */
  static void clearRegistry();

private:
  // JSON escape a string
  static std::string jsonEscape(const std::string& s);

  // Maximum depth for recursive conversion
  static constexpr int MAX_DEPTH = 32;
  // Maximum list/dict size to serialize as JSON
  static constexpr size_t MAX_INLINE_SIZE = 10000;
};

} // namespace pynect
