/**
 * pynect - Python Bridge Implementation
 * Core Python operations: import, eval, attribute access, function calls.
 */

#include "python_bridge.h"
#include "gil_guard.h"
#include "type_converter.h"

#include <Python.h>
#include <sstream>
#include <stdexcept>
#include <iostream>
#include <algorithm>

namespace pynect {

// Singleton

PythonBridge& PythonBridge::getInstance() {
  static PythonBridge instance;
  return instance;
}

// Initialize Python

void PythonBridge::initializePython(
  const std::string& pythonHome,
  const std::string& pythonExecutable,
  const std::vector<std::string>& extraSysPaths,
  const std::vector<std::pair<std::string, std::string>>& envVars
) {
  if (_initialized) {
    throw std::runtime_error("Python already initialized");
  }

  // Set environment variables before initialization
  for (const auto& [key, val] : envVars) {
#ifdef _WIN32
    _putenv_s(key.c_str(), val.c_str());
#else
    setenv(key.c_str(), val.c_str(), 1);
#endif
  }

  // Configure the interpreter with the detected executable so CPython can
  // resolve its standard library consistently across platforms.
  PyConfig config;
  PyConfig_InitPythonConfig(&config);
  PyStatus status = PyConfig_SetBytesString(
    &config,
    &config.program_name,
    pythonExecutable.c_str()
  );
  if (!PyStatus_Exception(status) && !pythonHome.empty()) {
    status = PyConfig_SetBytesString(&config, &config.home, pythonHome.c_str());
  }
  if (!PyStatus_Exception(status)) {
    status = Py_InitializeFromConfig(&config);
  }
  std::string configError = PyStatus_Exception(status) && status.err_msg
    ? status.err_msg
    : "";
  PyConfig_Clear(&config);
  if (PyStatus_Exception(status)) {
    throw std::runtime_error("Failed to configure Python: " + configError);
  }

  if (!Py_IsInitialized()) {
    throw std::runtime_error("Failed to initialize Python interpreter");
  }

  // Enable thread support
  PyEval_InitThreads();

  // Save main thread state and release GIL so threads can run
  _mainThreadState = PyEval_SaveThread();

  // Add extra sys.path entries (done with GIL held)
  if (!extraSysPaths.empty()) {
    GILAcquire gil;
    PyObject* sysModule = PyImport_ImportModule("sys");
    if (sysModule) {
      PyRef sysRef = PyRef::steal(sysModule);
      PyObject* sysPath = PyObject_GetAttrString(sysModule, "path");
      if (sysPath) {
        PyRef pathRef = PyRef::steal(sysPath);
        for (const auto& p : extraSysPaths) {
          PyObject* pathStr = PyUnicode_FromString(p.c_str());
          if (pathStr) {
            PyList_Insert(sysPath, 0, pathStr);
            Py_DECREF(pathStr);
          }
        }
      }
    }
  }

  _initialized = true;
}

// Finalize Python

void PythonBridge::finalizePython() {
  if (!_initialized) return;

  // Re-acquire main thread's GIL before calling Py_Finalize
  if (_mainThreadState) {
    PyEval_RestoreThread(_mainThreadState);
    _mainThreadState = nullptr;
  }

  // Clear iterators
  {
    std::lock_guard<std::mutex> lock(_iteratorsMutex);
    for (auto& [id, iter] : _iterators) {
      Py_XDECREF(iter);
    }
    _iterators.clear();
  }

  // Clear object registry
  TypeConverter::clearRegistry();

  // Finalize Python
  Py_Finalize();
  _initialized = false;
}

// Helper: Make Error Result

TaskResult PythonBridge::_makeErrorResult() {
  TaskResult result;
  result.success = false;
  auto [type, msg, tb] = TypeConverter::captureException();
  result.errorType = type;
  result.errorMessage = msg;
  result.errorTraceback = tb;
  return result;
}

// Helper: Make Success Result

TaskResult PythonBridge::_makeSuccessResult(PyObject* obj) {
  TaskResult result;
  result.success = true;

  if (!obj || obj == Py_None) {
    result.resultJson = "null";
    return result;
  }

  // For objects that can't be fully serialized, register as opaque ref
  if (TypeConverter::isNumpyArray(obj) ||
      TypeConverter::isDataFrame(obj) ||
      TypeConverter::isSeries(obj) ||
      TypeConverter::isTorchTensor(obj) ||
      TypeConverter::isModule(obj) ||
      TypeConverter::isClass(obj)) {
    // Always return as object reference for these types
    result.objectId = TypeConverter::registerObject(obj);
    result.isObject = true;
    result.resultJson = "{\"__pyref__\":" + std::to_string(result.objectId) + "}";
    return result;
  }

  // For callable objects
  if (PyCallable_Check(obj) && !PyFunction_Check(obj) &&
      !PyModule_Check(obj) && !PyType_Check(obj)) {
    // Instance of a class with __call__ - usually want as reference
    result.objectId = TypeConverter::registerObject(obj);
    result.isObject = true;
    result.resultJson = "{\"__pyref__\":" + std::to_string(result.objectId) + "}";
    return result;
  }

  SerializedValue sv = TypeConverter::pythonToSerialized(obj);

  if (sv.format == SerializedFormat::PYTHON_REF) {
    result.objectId = sv.metadata.objectId;
    result.isObject = true;
    result.resultJson = "{\"__pyref__\":" + std::to_string(result.objectId) + "}";
  } else if (sv.format == SerializedFormat::JSON) {
    result.resultJson = sv.jsonData;
    result.isObject = false;
  } else {
    // Binary format - register as object for now
    // In production, pass binary data through
    result.objectId = TypeConverter::registerObject(obj);
    result.isObject = true;
    result.resultJson = "{\"__pyref__\":" + std::to_string(result.objectId) + "}";
  }

  return result;
}

// Module Import

TaskResult PythonBridge::importModuleSync(const std::string& moduleName) {
  // GIL must be held by caller
  PyObject* dispatcher = PyImport_ImportModule("pynect_dispatcher");
  if (!dispatcher) {
    return _makeErrorResult();
  }
  PyRef dispatcherRef = PyRef::steal(dispatcher);
  PyObject* isAllowed = PyObject_GetAttrString(dispatcher, "is_module_allowed");
  if (!isAllowed) {
    return _makeErrorResult();
  }
  PyRef isAllowedRef = PyRef::steal(isAllowed);
  PyObject* allowed = PyObject_CallFunction(isAllowed, "s", moduleName.c_str());
  if (!allowed) {
    return _makeErrorResult();
  }
  PyRef allowedRef = PyRef::steal(allowed);
  if (PyObject_IsTrue(allowed) != 1) {
    PyErr_Format(PyExc_PermissionError, "Python module is not allowed: %s", moduleName.c_str());
    return _makeErrorResult();
  }

  PyObject* module = PyImport_ImportModule(moduleName.c_str());
  if (!module) {
    return _makeErrorResult();
  }

  PyRef modRef = PyRef::steal(module);
  TaskResult result;
  result.success = true;
  result.objectId = TypeConverter::registerObject(module);
  result.isObject = true;
  result.resultJson = "{\"__pyref__\":" + std::to_string(result.objectId) + "}";
  return result;
}

TaskResult PythonBridge::reloadModuleSync(uint32_t objectId) {
  PyObject* module = TypeConverter::getObject(objectId);
  if (!module) {
    TaskResult r;
    r.success = false;
    r.errorType = "ValueError";
    r.errorMessage = "Object ID " + std::to_string(objectId) + " not found";
    return r;
  }

  PyObject* reloaded = PyImport_ReloadModule(module);
  if (!reloaded) {
    return _makeErrorResult();
  }

  PyRef reloadedRef = PyRef::steal(reloaded);

  // Update registry
  TypeConverter::decRef(objectId);
  uint32_t newId = TypeConverter::registerObject(reloaded);

  TaskResult result;
  result.success = true;
  result.objectId = newId;
  result.isObject = true;
  result.resultJson = "{\"__pyref__\":" + std::to_string(newId) + "}";
  return result;
}

// Attribute Access

TaskResult PythonBridge::getAttributeSync(uint32_t objectId, const std::string& attrName) {
  PyObject* obj = TypeConverter::getObject(objectId);
  if (!obj) {
    TaskResult r;
    r.success = false;
    r.errorType = "ValueError";
    r.errorMessage = "Object not found: id=" + std::to_string(objectId);
    return r;
  }

  PyObject* attr = PyObject_GetAttrString(obj, attrName.c_str());
  if (!attr) {
    return _makeErrorResult();
  }

  PyRef attrRef = PyRef::steal(attr);
  return _makeSuccessResult(attr);
}

TaskResult PythonBridge::getAttributePathSync(
  uint32_t objectId,
  const std::vector<std::string>& path
) {
  PyObject* obj = TypeConverter::getObject(objectId);
  if (!obj) {
    TaskResult r;
    r.success = false;
    r.errorType = "ValueError";
    r.errorMessage = "Object not found: id=" + std::to_string(objectId);
    return r;
  }

  if (path.empty()) {
    return _makeSuccessResult(obj);
  }

  PyObject* resolved = _resolveAttributePath(obj, path);
  if (!resolved) {
    return _makeErrorResult();
  }

  PyRef resolvedRef = PyRef::steal(resolved);
  return _makeSuccessResult(resolved);
}

PyObject* PythonBridge::_resolveAttributePath(
  PyObject* obj,
  const std::vector<std::string>& path
) {
  if (!obj || path.empty()) {
    if (obj) Py_INCREF(obj);
    return obj;
  }

  Py_INCREF(obj);
  PyObject* current = obj;

  for (const auto& attr : path) {
    PyObject* next = PyObject_GetAttrString(current, attr.c_str());
    Py_DECREF(current);

    if (!next) {
      return nullptr;  // Exception set
    }
    current = next;
  }

  return current;  // new reference
}

TaskResult PythonBridge::setAttributeSync(
  uint32_t objectId,
  const std::string& attrName,
  const SerializedValue& value
) {
  PyObject* obj = TypeConverter::getObject(objectId);
  if (!obj) {
    TaskResult r;
    r.success = false;
    r.errorType = "ValueError";
    r.errorMessage = "Object not found";
    return r;
  }

  PyObject* pyValue = _deserialize(value);
  if (!pyValue) {
    TaskResult r;
    r.success = false;
    r.errorType = "ValueError";
    r.errorMessage = "Failed to deserialize value";
    return r;
  }
  PyRef valueRef = PyRef::steal(pyValue);

  int ret = PyObject_SetAttrString(obj, attrName.c_str(), pyValue);
  if (ret != 0) {
    return _makeErrorResult();
  }

  TaskResult result;
  result.success = true;
  result.resultJson = "true";
  return result;
}

bool PythonBridge::hasAttributeSync(uint32_t objectId, const std::string& attrName) {
  PyObject* obj = TypeConverter::getObject(objectId);
  if (!obj) return false;
  return PyObject_HasAttrString(obj, attrName.c_str()) == 1;
}

TaskResult PythonBridge::deleteAttributeSync(uint32_t objectId, const std::string& attrName) {
  PyObject* obj = TypeConverter::getObject(objectId);
  if (!obj) {
    TaskResult r;
    r.success = false;
    r.errorType = "ValueError";
    r.errorMessage = "Object not found";
    return r;
  }

  int ret = PyObject_DelAttrString(obj, attrName.c_str());
  if (ret != 0) {
    return _makeErrorResult();
  }

  TaskResult result;
  result.success = true;
  result.resultJson = "true";
  return result;
}

// Function Calls

TaskResult PythonBridge::callFunctionSync(
  uint32_t objectId,
  const std::vector<std::string>& path,
  const CallOptions& options
) {
  PyObject* obj = TypeConverter::getObject(objectId);
  if (!obj) {
    TaskResult r;
    r.success = false;
    r.errorType = "ValueError";
    r.errorMessage = "Object not found: id=" + std::to_string(objectId);
    return r;
  }

  // Resolve path to callable
  PyObject* callable;
  if (path.empty()) {
    Py_INCREF(obj);
    callable = obj;
  } else {
    callable = _resolveAttributePath(obj, path);
    if (!callable) {
      return _makeErrorResult();
    }
  }
  PyRef callableRef = PyRef::steal(callable);

  if (!PyCallable_Check(callable)) {
    // The result is the object at the path, not a callable
    // Return it as a value
    return _makeSuccessResult(callable);
  }

  // Build args and kwargs
  PyObject* argsObj = nullptr;
  PyObject* kwargsObj = nullptr;

  if (!_buildCallArgs(options, argsObj, kwargsObj)) {
    Py_XDECREF(argsObj);
    Py_XDECREF(kwargsObj);
    return _makeErrorResult();
  }

  PyRef argsRef = PyRef::steal(argsObj);
  PyRef kwargsRef = PyRef::steal(kwargsObj);

  // Route every call through the policy/validation dispatcher. Pydantic is
  // imported lazily there and is not required by the native addon.
  PyObject* dispatcher = PyImport_ImportModule("pynect_dispatcher");
  if (!dispatcher) {
    return _makeErrorResult();
  }
  PyRef dispatcherRef = PyRef::steal(dispatcher);
  PyObject* invoke = PyObject_GetAttrString(dispatcher, "invoke");
  if (!invoke) {
    return _makeErrorResult();
  }
  PyRef invokeRef = PyRef::steal(invoke);
  PyObject* requestId = PyUnicode_FromString(options.requestId.c_str());
  if (!requestId) {
    return _makeErrorResult();
  }
  PyRef requestIdRef = PyRef::steal(requestId);
  PyObject* executionTimeout = PyLong_FromUnsignedLong(options.executionTimeoutMs);
  if (!executionTimeout) {
    return _makeErrorResult();
  }
  PyRef executionTimeoutRef = PyRef::steal(executionTimeout);
  PyObject* result = PyObject_CallFunctionObjArgs(
    invoke,
    callable,
    argsObj,
    kwargsObj,
    requestId,
    executionTimeout,
    nullptr
  );

  if (!result) {
    return _makeErrorResult();
  }

  PyRef resultRef = PyRef::steal(result);
  return _makeSuccessResult(result);
}

TaskResult PythonBridge::callMethodSync(
  uint32_t objectId,
  const std::string& methodName,
  const CallOptions& options
) {
  return callFunctionSync(objectId, {methodName}, options);
}

TaskResult PythonBridge::cancelCallSync(const std::string& requestId) {
  PyObject* dispatcher = PyImport_ImportModule("pynect_dispatcher");
  if (!dispatcher) return _makeErrorResult();
  PyRef dispatcherRef = PyRef::steal(dispatcher);
  PyObject* cancel = PyObject_GetAttrString(dispatcher, "cancel");
  if (!cancel) return _makeErrorResult();
  PyRef cancelRef = PyRef::steal(cancel);
  PyObject* result = PyObject_CallFunction(cancel, "s", requestId.c_str());
  if (!result) return _makeErrorResult();
  PyRef resultRef = PyRef::steal(result);
  TaskResult output;
  output.success = true;
  output.resultJson = PyObject_IsTrue(result) ? "true" : "false";
  return output;
}

// Build Call Args

bool PythonBridge::_buildCallArgs(
  const CallOptions& options,
  PyObject*& argsOut,
  PyObject*& kwargsOut
) {
  // Build positional args tuple
  argsOut = PyTuple_New(static_cast<Py_ssize_t>(options.args.size()));
  if (!argsOut) return false;

  for (size_t i = 0; i < options.args.size(); ++i) {
    PyObject* arg = _deserialize(options.args[i]);
    if (!arg) {
      Py_DECREF(argsOut);
      argsOut = nullptr;
      return false;
    }
    PyTuple_SET_ITEM(argsOut, static_cast<Py_ssize_t>(i), arg);  // steals reference
  }

  // Build kwargs dict
  kwargsOut = PyDict_New();
  if (!kwargsOut) {
    Py_DECREF(argsOut);
    argsOut = nullptr;
    return false;
  }

  for (const auto& [key, val] : options.kwargs) {
    PyObject* pyVal = _deserialize(val);
    if (!pyVal) {
      Py_DECREF(argsOut);
      Py_DECREF(kwargsOut);
      argsOut = nullptr;
      kwargsOut = nullptr;
      return false;
    }
    PyDict_SetItemString(kwargsOut, key.c_str(), pyVal);
    Py_DECREF(pyVal);
  }

  return true;
}

// Deserialize

PyObject* PythonBridge::_deserialize(const SerializedValue& value) {
  switch (value.format) {
    case SerializedFormat::JSON:
      return TypeConverter::jsonToPython(value.jsonData);

    case SerializedFormat::MSGPACK:
      return TypeConverter::msgpackToPython(value.binaryData);

    case SerializedFormat::NUMPY_ARRAY:
      return TypeConverter::bufferToNumpyArray(
        value.binaryData,
        value.metadata.dtype,
        value.metadata.shape
      );

    case SerializedFormat::PYTHON_REF: {
      PyObject* obj = TypeConverter::getObject(value.metadata.objectId);
      if (!obj) {
        PyErr_SetString(PyExc_ValueError, "Python object reference not found");
        return nullptr;
      }
      Py_INCREF(obj);
      return obj;
    }

    case SerializedFormat::BYTES:
      return PyBytes_FromStringAndSize(
        reinterpret_cast<const char*>(value.binaryData.data()),
        static_cast<Py_ssize_t>(value.binaryData.size())
      );

    case SerializedFormat::NONE:
      Py_RETURN_NONE;

    default:
      // Try JSON fallback
      if (!value.jsonData.empty()) {
        return TypeConverter::jsonToPython(value.jsonData);
      }
      Py_RETURN_NONE;
  }
}

// Code Execution

TaskResult PythonBridge::runCodeSync(const std::string& code) {
  PyObject* mainModule = PyImport_AddModule("__main__");
  if (!mainModule) return _makeErrorResult();

  PyObject* globalDict = PyModule_GetDict(mainModule);  // borrowed

  PyObject* result = PyRun_String(code.c_str(), Py_file_input, globalDict, globalDict);
  if (!result) {
    return _makeErrorResult();
  }

  PyRef resultRef = PyRef::steal(result);
  TaskResult r;
  r.success = true;
  r.resultJson = "null";
  return r;
}

TaskResult PythonBridge::evalExpressionSync(const std::string& expression) {
  PyObject* mainModule = PyImport_AddModule("__main__");
  if (!mainModule) return _makeErrorResult();

  PyObject* globalDict = PyModule_GetDict(mainModule);  // borrowed

  PyObject* result = PyRun_String(expression.c_str(), Py_eval_input, globalDict, globalDict);
  if (!result) {
    return _makeErrorResult();
  }

  PyRef resultRef = PyRef::steal(result);
  return _makeSuccessResult(result);
}

TaskResult PythonBridge::runFileSync(const std::string& filePath) {
  FILE* fp = fopen(filePath.c_str(), "r");
  if (!fp) {
    TaskResult r;
    r.success = false;
    r.errorType = "FileNotFoundError";
    r.errorMessage = "Cannot open file: " + filePath;
    return r;
  }

  PyObject* mainModule = PyImport_AddModule("__main__");
  PyObject* globalDict = PyModule_GetDict(mainModule);

  PyObject* result = PyRun_File(fp, filePath.c_str(), Py_file_input, globalDict, globalDict);
  fclose(fp);

  if (!result) {
    return _makeErrorResult();
  }

  PyRef resultRef = PyRef::steal(result);
  TaskResult r;
  r.success = true;
  r.resultJson = "null";
  return r;
}

// Object Operations

TaskResult PythonBridge::getObjectValueSync(uint32_t objectId) {
  PyObject* obj = TypeConverter::getObject(objectId);
  if (!obj) {
    TaskResult r;
    r.success = false;
    r.errorType = "ValueError";
    r.errorMessage = "Object not found: id=" + std::to_string(objectId);
    return r;
  }
  return _makeSuccessResult(obj);
}

std::string PythonBridge::getObjectReprSync(uint32_t objectId) {
  PyObject* obj = TypeConverter::getObject(objectId);
  if (!obj) return "<deleted object>";
  return TypeConverter::getRepr(obj);
}

TaskResult PythonBridge::getObjectLengthSync(uint32_t objectId) {
  PyObject* obj = TypeConverter::getObject(objectId);
  if (!obj) {
    TaskResult r;
    r.success = false;
    r.errorType = "ValueError";
    r.errorMessage = "Object not found";
    return r;
  }

  Py_ssize_t len = PyObject_Length(obj);
  if (len < 0) {
    return _makeErrorResult();
  }

  TaskResult result;
  result.success = true;
  result.resultJson = std::to_string(len);
  return result;
}

TaskResult PythonBridge::getObjectKeysSync(uint32_t objectId) {
  PyObject* obj = TypeConverter::getObject(objectId);
  if (!obj) {
    TaskResult r;
    r.success = false;
    r.errorType = "ValueError";
    r.errorMessage = "Object not found";
    return r;
  }

  PyObject* dirList = PyObject_Dir(obj);
  if (!dirList) {
    return _makeErrorResult();
  }
  PyRef dirRef = PyRef::steal(dirList);

  std::ostringstream oss;
  oss << "[";
  Py_ssize_t size = PyList_Size(dirList);
  bool first = true;

  for (Py_ssize_t i = 0; i < size; ++i) {
    PyObject* name = PyList_GetItem(dirList, i);
    if (!name || !PyUnicode_Check(name)) continue;

    const char* nameStr = PyUnicode_AsUTF8(name);
    if (!nameStr) continue;

    // Filter out private names
    if (nameStr[0] == '_') continue;

    if (!first) oss << ",";
    first = false;
    oss << "\"" << nameStr << "\"";
  }
  oss << "]";

  TaskResult result;
  result.success = true;
  result.resultJson = oss.str();
  return result;
}

// Iterator Support

TaskResult PythonBridge::createIteratorSync(
  uint32_t objectId,
  const std::vector<std::string>& path
) {
  PyObject* obj = TypeConverter::getObject(objectId);
  if (!obj) {
    TaskResult r;
    r.success = false;
    r.errorType = "ValueError";
    r.errorMessage = "Object not found";
    return r;
  }

  // Resolve path
  PyObject* target;
  if (path.empty()) {
    Py_INCREF(obj);
    target = obj;
  } else {
    target = _resolveAttributePath(obj, path);
    if (!target) return _makeErrorResult();
  }
  PyRef targetRef = PyRef::steal(target);

  // Create iterator
  PyObject* iter = PyObject_GetIter(target);
  if (!iter) {
    return _makeErrorResult();
  }

  uint32_t iteratorId = _nextIteratorId.fetch_add(1, std::memory_order_relaxed);
  {
    std::lock_guard<std::mutex> lock(_iteratorsMutex);
    _iterators[iteratorId] = iter;  // takes ownership
  }

  TaskResult result;
  result.success = true;
  result.objectId = iteratorId;
  result.resultJson = "{\"iteratorId\":" + std::to_string(iteratorId) + "}";
  return result;
}

TaskResult PythonBridge::iteratorNextSync(uint32_t iteratorId) {
  PyObject* iter = nullptr;
  {
    std::lock_guard<std::mutex> lock(_iteratorsMutex);
    auto it = _iterators.find(iteratorId);
    if (it == _iterators.end()) {
      TaskResult r;
      r.success = false;
      r.errorType = "ValueError";
      r.errorMessage = "Iterator not found: id=" + std::to_string(iteratorId);
      return r;
    }
    iter = it->second;
  }

  PyObject* next = PyIter_Next(iter);

  if (!next) {
    if (PyErr_ExceptionMatches(PyExc_StopIteration)) {
      PyErr_Clear();
      // Normal end of iteration
      TaskResult result;
      result.success = true;
      result.resultJson = "{\"done\":true}";
      return result;
    }
    return _makeErrorResult();
  }

  PyRef nextRef = PyRef::steal(next);
  TaskResult itemResult = _makeSuccessResult(next);

  if (itemResult.isObject) {
    itemResult.resultJson = "{\"done\":false,\"value\":{\"__pyref__\":" +
                             std::to_string(itemResult.objectId) + "}}";
  } else {
    itemResult.resultJson = "{\"done\":false,\"value\":" + itemResult.resultJson + "}";
  }

  return itemResult;
}

void PythonBridge::destroyIteratorSync(uint32_t iteratorId) {
  PyObject* iter = nullptr;
  {
    std::lock_guard<std::mutex> lock(_iteratorsMutex);
    auto it = _iterators.find(iteratorId);
    if (it != _iterators.end()) {
      iter = it->second;
      _iterators.erase(it);
    }
  }
  Py_XDECREF(iter);
}

// Memory

void PythonBridge::collectGarbage() {
  GILAcquire gil;
  PyObject* gcModule = PyImport_ImportModule("gc");
  if (gcModule) {
    PyRef gcRef = PyRef::steal(gcModule);
    PyObject* collect = PyObject_GetAttrString(gcModule, "collect");
    if (collect) {
      PyRef collectRef = PyRef::steal(collect);
      PyObject* result = PyObject_CallNoArgs(collect);
      Py_XDECREF(result);
    } else { PyErr_Clear(); }
  } else { PyErr_Clear(); }
}

size_t PythonBridge::getTrackedObjectCount() const {
  return TypeConverter::getRegisteredCount();
}

} // namespace pynect
