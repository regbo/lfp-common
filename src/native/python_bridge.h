/**
 * pynect - Python Bridge Header
 * High-level operations on Python objects: import, call, attribute access.
 * Uses TypeConverter for serialization and ThreadPool for async execution.
 */

#pragma once

#include <Python.h>
#include <napi.h>
#include <string>
#include <vector>
#include <memory>
#include <functional>
#include <map>

#include "type_converter.h"
#include "thread_pool.h"

namespace pynect {

/**
 * Options for function calls.
 */
struct CallOptions {
  std::vector<SerializedValue> args;
  std::vector<std::pair<std::string, SerializedValue>> kwargs;
  uint32_t timeoutMs = 0;
  uint32_t executionTimeoutMs = 0;
  std::string requestId;
};

/**
 * Attribute access result.
 */
struct AttributeResult {
  bool success = false;
  SerializedValue value;
  bool isCallable = false;
  bool isObject = false;
  uint32_t objectId = 0;
  std::string errorType;
  std::string errorMessage;
  std::string errorTraceback;
};

/**
 * PythonBridge - orchestrates Python operations.
 *
 * This class provides the business logic on top of raw Python C API calls.
 * All operations are designed to be executed in worker threads (GIL held).
 */
class PythonBridge {
public:
  static PythonBridge& getInstance();

  // Non-copyable singleton
  PythonBridge(const PythonBridge&) = delete;
  PythonBridge& operator=(const PythonBridge&) = delete;

  // Python Lifecycle

  /**
   * Initialize the Python interpreter.
   * Must be called once from the main thread before any Python operations.
   */
  void initializePython(
    const std::string& pythonHome,
    const std::string& pythonExecutable,
    const std::string& pythonLibrary,
    const std::vector<std::string>& extraSysPaths,
    const std::vector<std::pair<std::string, std::string>>& envVars
  );

  /**
   * Finalize the Python interpreter.
   * Must be called once from the main thread at shutdown.
   */
  void finalizePython();

  bool isInitialized() const noexcept { return _initialized; }

  // Module Import

  /**
   * Import a Python module. Returns objectId.
   * Sync version (GIL must be held by caller).
   */
  TaskResult importModuleSync(const std::string& moduleName);

  /**
   * Reload a module by objectId.
   */
  TaskResult reloadModuleSync(uint32_t objectId);

  // Attribute Access

  /**
   * Get attribute from a Python object by name.
   */
  TaskResult getAttributeSync(uint32_t objectId, const std::string& attrName);

  /**
   * Get attribute path (chain of attribute accesses).
   * e.g. path = ["groupby", "agg"] means obj.groupby.agg
   */
  TaskResult getAttributePathSync(
    uint32_t objectId,
    const std::vector<std::string>& path
  );

  /**
   * Set attribute on a Python object.
   */
  TaskResult setAttributeSync(
    uint32_t objectId,
    const std::string& attrName,
    const SerializedValue& value
  );

  /**
   * Check if an attribute exists.
   */
  bool hasAttributeSync(uint32_t objectId, const std::string& attrName);

  /**
   * Delete an attribute.
   */
  TaskResult deleteAttributeSync(uint32_t objectId, const std::string& attrName);

  // Function Calls

  /**
   * Call a Python callable (resolving attribute path first).
   */
  TaskResult callFunctionSync(
    uint32_t objectId,
    const std::vector<std::string>& path,
    const CallOptions& options
  );

  /**
   * Call a method by name on a Python object.
   */
  TaskResult callMethodSync(
    uint32_t objectId,
    const std::string& methodName,
    const CallOptions& options
  );

  /** Cooperatively cancel a running asynchronous call. */
  TaskResult cancelCallSync(const std::string& requestId);

  // Direct Evaluation

  /**
   * Run arbitrary Python code (statements).
   */
  TaskResult runCodeSync(const std::string& code);

  /**
   * Evaluate a Python expression and return the result.
   */
  TaskResult evalExpressionSync(const std::string& expression);

  /**
   * Run a Python file.
   */
  TaskResult runFileSync(const std::string& filePath);

  // Object Operations

  /**
   * Get the serialized value of an object (resolve it).
   */
  TaskResult getObjectValueSync(uint32_t objectId);

  /**
   * Get repr() of an object.
   */
  std::string getObjectReprSync(uint32_t objectId);

  /**
   * Get len() of an object.
   */
  TaskResult getObjectLengthSync(uint32_t objectId);

  /**
   * Get list of attribute names (dir()).
   */
  TaskResult getObjectKeysSync(uint32_t objectId);

  // Iterator Support

  /**
   * Create an iterator for an object.
   */
  TaskResult createIteratorSync(uint32_t objectId, const std::vector<std::string>& path);

  /**
   * Get next value from an iterator.
   */
  TaskResult iteratorNextSync(uint32_t iteratorId);

  /**
   * Destroy an iterator.
   */
  void destroyIteratorSync(uint32_t iteratorId);

  // Memory

  void collectGarbage();
  size_t getTrackedObjectCount() const;

private:
  PythonBridge() = default;
  ~PythonBridge() = default;

  /**
   * Resolve attribute path starting from an objectId.
   * Returns new Python reference, or nullptr on error.
   * GIL must be held.
   */
  PyObject* _resolveAttributePath(
    PyObject* obj,
    const std::vector<std::string>& path
  );

  /**
   * Convert a SerializedValue back to a Python object.
   * Returns new reference.
   */
  PyObject* _deserialize(const SerializedValue& value);

  /**
   * Build Python args tuple and kwargs dict from CallOptions.
   */
  bool _buildCallArgs(
    const CallOptions& options,
    PyObject*& argsOut,
    PyObject*& kwargsOut
  );

  /**
   * Build a TaskResult from Python exception state.
   */
  TaskResult _makeErrorResult();

  /**
   * Build a successful TaskResult from a Python object.
   */
  TaskResult _makeSuccessResult(PyObject* obj);

  bool _initialized = false;
  PyThreadState* _mainThreadState = nullptr;

  // Iterator registry: iteratorId -> Python iterator object
  std::map<uint32_t, PyObject*> _iterators;
  std::mutex _iteratorsMutex;
  std::atomic<uint32_t> _nextIteratorId{1};
};

} // namespace pynect
