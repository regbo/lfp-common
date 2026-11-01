/**
 * pynect - N-API Addon Entry Point
 *
 * This file is the bridge between Node.js (via N-API) and the Python C API.
 * It exports all functions that the TypeScript layer calls.
 *
 * Architecture:
 * - Synchronous operations -> directly call PythonBridge::*Sync() in a worker thread
 * - All Python work happens in worker threads (never on the JS event loop)
 * - Results flow back via ThreadSafeFunction callbacks
 * - Memory management via TypeConverter::registerObject/decRef
 */

#define NAPI_VERSION 8
#include <napi.h>
#include <Python.h>

#include "python_bridge.h"
#include "thread_pool.h"
#include "type_converter.h"
#include "gil_guard.h"

#include <memory>
#include <string>
#include <vector>
#include <map>
#include <sstream>
#include <stdexcept>
#include <iostream>
#include <chrono>
#include <ctime>

namespace pynect {

// Global Thread Pool

static std::unique_ptr<PythonThreadPool> g_threadPool;
static bool g_initialized = false;
static bool g_includeTracebacks = false;

// Helper: Extract SerializedValue from JS object

static SerializedValue jsToSerializedValue(const Napi::Object& obj) {
  SerializedValue sv;

  if (!obj.Has("format")) {
    sv.format = SerializedFormat::NONE;
    return sv;
  }

  int32_t fmt = obj.Get("format").As<Napi::Number>().Int32Value();
  sv.format = static_cast<SerializedFormat>(fmt);

  if (obj.Has("data")) {
    Napi::Value data = obj.Get("data");
    if (data.IsString()) {
      sv.jsonData = data.As<Napi::String>().Utf8Value();
    } else if (data.IsBuffer()) {
      Napi::Buffer<uint8_t> buf = data.As<Napi::Buffer<uint8_t>>();
      sv.binaryData.assign(buf.Data(), buf.Data() + buf.Length());
    }
  }

  if (obj.Has("metadata") && obj.Get("metadata").IsObject()) {
    Napi::Object meta = obj.Get("metadata").As<Napi::Object>();
    if (meta.Has("objectId")) {
      sv.metadata.objectId = meta.Get("objectId").As<Napi::Number>().Uint32Value();
    }
    if (meta.Has("dtype") && meta.Get("dtype").IsString()) {
      sv.metadata.dtype = meta.Get("dtype").As<Napi::String>().Utf8Value();
    }
    if (meta.Has("shape") && meta.Get("shape").IsArray()) {
      Napi::Array shape = meta.Get("shape").As<Napi::Array>();
      for (uint32_t i = 0; i < shape.Length(); ++i) {
        sv.metadata.shape.push_back(shape.Get(i).As<Napi::Number>().Int64Value());
      }
    }
  }

  return sv;
}

// Helper: Convert TaskResult to JS object

static Napi::Object taskResultToJS(Napi::Env env, const TaskResult& result) {
  Napi::Object obj = Napi::Object::New(env);
  obj.Set("success", Napi::Boolean::New(env, result.success));

  if (result.success) {
    // Parse result JSON to return as JS value
    if (!result.resultJson.empty() && result.resultJson != "null") {
      // Return raw JSON string to be parsed in TypeScript
      obj.Set("resultJson", Napi::String::New(env, result.resultJson));
    } else {
      obj.Set("resultJson", env.Null());
    }

    if (result.isObject) {
      obj.Set("objectId", Napi::Number::New(env, result.objectId));
      obj.Set("isObject", Napi::Boolean::New(env, true));
    } else {
      obj.Set("isObject", Napi::Boolean::New(env, false));
    }
  } else {
    Napi::Object error = Napi::Object::New(env);
    error.Set("type", Napi::String::New(env, result.errorType));
    error.Set("message", Napi::String::New(env, result.errorMessage));
    error.Set("traceback", Napi::String::New(
      env,
      g_includeTracebacks ? result.errorTraceback : ""
    ));
    obj.Set("error", error);
  }

  return obj;
}

// Exported Functions

/**
 * initializePython(options) -> Promise<void>
 * Initialize the CPython interpreter with given options.
 */
static Napi::Value InitializePython(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (g_initialized) {
    return env.Undefined();
  }

  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "initializePython expects an options object").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Object opts = info[0].As<Napi::Object>();

  std::string pythonHome = opts.Has("pythonHome") ?
    opts.Get("pythonHome").As<Napi::String>().Utf8Value() : "";

  std::string pythonExecutable = opts.Has("pythonExecutable") ?
    opts.Get("pythonExecutable").As<Napi::String>().Utf8Value() : "python3";

  uint32_t threadPoolSize = opts.Has("threadPoolSize") ?
    opts.Get("threadPoolSize").As<Napi::Number>().Uint32Value() : 4;

  uint32_t maxQueueSize = opts.Has("maxQueueSize") ?
    opts.Get("maxQueueSize").As<Napi::Number>().Uint32Value() : 1000;

  g_includeTracebacks = opts.Has("includeTracebacks") &&
    opts.Get("includeTracebacks").ToBoolean().Value();

  std::vector<std::string> pythonPathExtra;
  if (opts.Has("pythonPathExtra") && opts.Get("pythonPathExtra").IsArray()) {
    Napi::Array paths = opts.Get("pythonPathExtra").As<Napi::Array>();
    for (uint32_t i = 0; i < paths.Length(); ++i) {
      pythonPathExtra.push_back(paths.Get(i).As<Napi::String>().Utf8Value());
    }
  }

  std::vector<std::pair<std::string, std::string>> envVars;
  if (opts.Has("env") && opts.Get("env").IsObject()) {
    Napi::Object envObj = opts.Get("env").As<Napi::Object>();
    Napi::Array keys = envObj.GetPropertyNames();
    for (uint32_t i = 0; i < keys.Length(); ++i) {
      std::string key = keys.Get(i).As<Napi::String>().Utf8Value();
      std::string val = envObj.Get(key).As<Napi::String>().Utf8Value();
      envVars.push_back({key, val});
    }
  }

  // Return a Promise
  auto deferred = Napi::Promise::Deferred::New(env);

  // Initialize Python synchronously (must happen on main thread)
  try {
    PythonBridge::getInstance().initializePython(
      pythonHome,
      pythonExecutable,
      pythonPathExtra,
      envVars
    );

    // Initialize thread pool
    g_threadPool = std::make_unique<PythonThreadPool>(threadPoolSize, maxQueueSize);
    g_threadPool->initialize(env);

    g_initialized = true;
    deferred.Resolve(env.Undefined());
  } catch (const std::exception& e) {
    deferred.Reject(Napi::Error::New(env, e.what()).Value());
  }

  return deferred.Promise();
}

/**
 * finalizePython() -> Promise<void>
 */
static Napi::Value FinalizePython(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto deferred = Napi::Promise::Deferred::New(env);

  if (!g_initialized) {
    deferred.Resolve(env.Undefined());
    return deferred.Promise();
  }

  try {
    if (g_threadPool &&
        (g_threadPool->getActiveThreadCount() > 0 || g_threadPool->getQueueSize() > 0)) {
      throw std::runtime_error(
        "Cannot finalize Python while calls are active or queued"
      );
    }
    if (g_threadPool) {
      g_threadPool->shutdown();
      g_threadPool.reset();
    }

    PythonBridge::getInstance().finalizePython();
    g_initialized = false;
    deferred.Resolve(env.Undefined());
  } catch (const std::exception& e) {
    deferred.Reject(Napi::Error::New(env, e.what()).Value());
  }

  return deferred.Promise();
}

/**
 * isInitialized() -> boolean
 */
static Napi::Value IsInitialized(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), g_initialized);
}

// Generic async wrapper

/**
 * Submits a task to the thread pool and returns a Promise.
 * The work function runs with the GIL held in a worker thread.
 */
static Napi::Value SubmitTask(
  Napi::Env env,
  std::function<TaskResult()> work,
  uint32_t timeoutMs = 0,
  std::string cancelKey = {}
) {
  auto deferred = std::make_shared<Napi::Promise::Deferred>(
    Napi::Promise::Deferred::New(env)
  );

  if (!g_initialized || !g_threadPool) {
    deferred->Reject(Napi::Error::New(env, "pynect not initialized").Value());
    return deferred->Promise();
  }

  // Capture deferred by shared_ptr to safely use in callback
  g_threadPool->submit(
    std::move(work),
    [deferred](TaskResult result) {
      Napi::Env callEnv = deferred->Env();
      Napi::HandleScope scope(callEnv);

      Napi::Object resultObj = taskResultToJS(callEnv, result);

      if (result.success) {
        deferred->Resolve(resultObj);
      } else {
        // Create a proper JS Error
        std::string errMsg = "[Python " + result.errorType + "] " + result.errorMessage;
        Napi::Error jsError = Napi::Error::New(callEnv, errMsg);
        jsError.Value().As<Napi::Object>().Set("pythonType",
          Napi::String::New(callEnv, result.errorType));
        if (g_includeTracebacks) {
          jsError.Value().As<Napi::Object>().Set("pythonTraceback",
            Napi::String::New(callEnv, result.errorTraceback));
        }
        deferred->Reject(jsError.Value());
      }
    },
    timeoutMs,
    std::move(cancelKey)
  );

  return deferred->Promise();
}

/**
 * importModule(moduleName) -> Promise<{objectId, success}>
 */
static Napi::Value ImportModule(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "importModule expects a string").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  std::string moduleName = info[0].As<Napi::String>().Utf8Value();

  return SubmitTask(env, [moduleName]() -> TaskResult {
    return PythonBridge::getInstance().importModuleSync(moduleName);
  });
}

/**
 * reloadModule(objectId) -> Promise<result>
 */
static Napi::Value ReloadModule(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  uint32_t objectId = info[0].As<Napi::Number>().Uint32Value();

  return SubmitTask(env, [objectId]() -> TaskResult {
    return PythonBridge::getInstance().reloadModuleSync(objectId);
  });
}

/**
 * getAttribute(objectId, name) -> Promise<result>
 */
static Napi::Value GetAttribute(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  uint32_t objectId = info[0].As<Napi::Number>().Uint32Value();
  std::string attrName = info[1].As<Napi::String>().Utf8Value();

  return SubmitTask(env, [objectId, attrName]() -> TaskResult {
    return PythonBridge::getInstance().getAttributeSync(objectId, attrName);
  });
}

/**
 * getAttributePath(objectId, path[]) -> Promise<result>
 */
static Napi::Value GetAttributePath(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  uint32_t objectId = info[0].As<Napi::Number>().Uint32Value();

  std::vector<std::string> path;
  if (info[1].IsArray()) {
    Napi::Array pathArr = info[1].As<Napi::Array>();
    for (uint32_t i = 0; i < pathArr.Length(); ++i) {
      path.push_back(pathArr.Get(i).As<Napi::String>().Utf8Value());
    }
  }

  return SubmitTask(env, [objectId, path]() -> TaskResult {
    return PythonBridge::getInstance().getAttributePathSync(objectId, path);
  });
}

/**
 * setAttribute(objectId, name, value) -> Promise<boolean>
 */
static Napi::Value SetAttribute(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  uint32_t objectId = info[0].As<Napi::Number>().Uint32Value();
  std::string attrName = info[1].As<Napi::String>().Utf8Value();
  SerializedValue value = jsToSerializedValue(info[2].As<Napi::Object>());

  return SubmitTask(env, [objectId, attrName, value]() -> TaskResult {
    return PythonBridge::getInstance().setAttributeSync(objectId, attrName, value);
  });
}

/**
 * hasAttribute(objectId, name) -> Promise<boolean>
 */
static Napi::Value HasAttribute(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  uint32_t objectId = info[0].As<Napi::Number>().Uint32Value();
  std::string attrName = info[1].As<Napi::String>().Utf8Value();

  auto deferred = Napi::Promise::Deferred::New(env);

  if (!g_initialized || !g_threadPool) {
    deferred.Reject(Napi::Error::New(env, "pynect not initialized").Value());
    return deferred.Promise();
  }

  auto deferredPtr = std::make_shared<Napi::Promise::Deferred>(std::move(deferred));
  g_threadPool->submit(
    [objectId, attrName]() -> TaskResult {
      GILAcquire gil;
      bool has = PythonBridge::getInstance().hasAttributeSync(objectId, attrName);
      TaskResult r;
      r.success = true;
      r.resultJson = has ? "true" : "false";
      return r;
    },
    [deferredPtr](TaskResult result) {
      Napi::Env callEnv = deferredPtr->Env();
      Napi::HandleScope scope(callEnv);
      bool hasIt = result.resultJson == "true";
      deferredPtr->Resolve(Napi::Boolean::New(callEnv, hasIt));
    }
  );

  return deferredPtr->Promise();
}

/**
 * deleteAttribute(objectId, name) -> Promise<boolean>
 */
static Napi::Value DeleteAttribute(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  uint32_t objectId = info[0].As<Napi::Number>().Uint32Value();
  std::string attrName = info[1].As<Napi::String>().Utf8Value();

  return SubmitTask(env, [objectId, attrName]() -> TaskResult {
    return PythonBridge::getInstance().deleteAttributeSync(objectId, attrName);
  });
}

/**
 * callFunction(objectId, path[], options) -> Promise<result>
 */
static Napi::Value CallFunction(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  uint32_t objectId = info[0].As<Napi::Number>().Uint32Value();

  std::vector<std::string> path;
  if (info[1].IsArray()) {
    Napi::Array pathArr = info[1].As<Napi::Array>();
    for (uint32_t i = 0; i < pathArr.Length(); ++i) {
      path.push_back(pathArr.Get(i).As<Napi::String>().Utf8Value());
    }
  }

  CallOptions options;
  options.timeoutMs = 0;

  if (info[2].IsObject()) {
    Napi::Object optsObj = info[2].As<Napi::Object>();

    if (optsObj.Has("args") && optsObj.Get("args").IsArray()) {
      Napi::Array args = optsObj.Get("args").As<Napi::Array>();
      for (uint32_t i = 0; i < args.Length(); ++i) {
        if (args.Get(i).IsObject()) {
          options.args.push_back(jsToSerializedValue(args.Get(i).As<Napi::Object>()));
        } else {
          // Plain value - wrap as JSON
          SerializedValue sv;
          sv.format = SerializedFormat::JSON;
          sv.jsonData = args.Get(i).As<Napi::String>().Utf8Value();
          options.args.push_back(sv);
        }
      }
    }

    if (optsObj.Has("kwargs") && optsObj.Get("kwargs").IsObject()) {
      Napi::Object kwargs = optsObj.Get("kwargs").As<Napi::Object>();
      Napi::Array kkeys = kwargs.GetPropertyNames();
      for (uint32_t i = 0; i < kkeys.Length(); ++i) {
        std::string key = kkeys.Get(i).As<Napi::String>().Utf8Value();
        if (kwargs.Get(key).IsObject()) {
          options.kwargs.push_back({key, jsToSerializedValue(kwargs.Get(key).As<Napi::Object>())});
        }
      }
    }

    if (optsObj.Has("timeout") && optsObj.Get("timeout").IsNumber()) {
      options.timeoutMs = optsObj.Get("timeout").As<Napi::Number>().Uint32Value();
    }
    if (optsObj.Has("executionTimeout") && optsObj.Get("executionTimeout").IsNumber()) {
      options.executionTimeoutMs = optsObj.Get("executionTimeout").As<Napi::Number>().Uint32Value();
    }
    if (optsObj.Has("requestId") && optsObj.Get("requestId").IsString()) {
      options.requestId = optsObj.Get("requestId").As<Napi::String>().Utf8Value();
    }
  }

  return SubmitTask(env, [objectId, path, options]() -> TaskResult {
    return PythonBridge::getInstance().callFunctionSync(objectId, path, options);
  }, options.timeoutMs, options.requestId);
}

/**
 * callMethod(objectId, methodName, options) -> Promise<result>
 */
static Napi::Value CallMethod(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  uint32_t objectId = info[0].As<Napi::Number>().Uint32Value();
  std::string methodName = info[1].As<Napi::String>().Utf8Value();

  CallOptions options;
  if (info[2].IsObject()) {
    Napi::Object optsObj = info[2].As<Napi::Object>();
    if (optsObj.Has("args") && optsObj.Get("args").IsArray()) {
      Napi::Array args = optsObj.Get("args").As<Napi::Array>();
      for (uint32_t i = 0; i < args.Length(); ++i) {
        if (args.Get(i).IsObject()) {
          options.args.push_back(jsToSerializedValue(args.Get(i).As<Napi::Object>()));
        }
      }
    }
    if (optsObj.Has("timeout") && optsObj.Get("timeout").IsNumber()) {
      options.timeoutMs = optsObj.Get("timeout").As<Napi::Number>().Uint32Value();
    }
    if (optsObj.Has("executionTimeout") && optsObj.Get("executionTimeout").IsNumber()) {
      options.executionTimeoutMs = optsObj.Get("executionTimeout").As<Napi::Number>().Uint32Value();
    }
    if (optsObj.Has("requestId") && optsObj.Get("requestId").IsString()) {
      options.requestId = optsObj.Get("requestId").As<Napi::String>().Utf8Value();
    }
  }

  return SubmitTask(env, [objectId, methodName, options]() -> TaskResult {
    return PythonBridge::getInstance().callMethodSync(objectId, methodName, options);
  }, options.timeoutMs, options.requestId);
}

/**
 * cancelCall(requestId) -> Promise<result>
 */
static Napi::Value CancelCall(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "cancelCall expects a request ID").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string requestId = info[0].As<Napi::String>().Utf8Value();
  if (g_threadPool && g_threadPool->cancel(requestId)) {
    auto deferred = Napi::Promise::Deferred::New(env);
    deferred.Resolve(Napi::Boolean::New(env, true));
    return deferred.Promise();
  }
  return SubmitTask(env, [requestId]() -> TaskResult {
    return PythonBridge::getInstance().cancelCallSync(requestId);
  });
}

/**
 * getTypeInfo(objectId) -> Promise<PyTypeInfo>
 */
static Napi::Value GetTypeInfo(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  uint32_t objectId = info[0].As<Napi::Number>().Uint32Value();

  return SubmitTask(env, [objectId]() -> TaskResult {
    GILAcquire gil;
    PyObject* obj = TypeConverter::getObject(objectId);
    if (!obj) {
      TaskResult r;
      r.success = false;
      r.errorType = "ValueError";
      r.errorMessage = "Object not found";
      return r;
    }

    std::string typeName = TypeConverter::getTypeName(obj);
    std::string qualName = TypeConverter::getQualifiedTypeName(obj);
    bool callable = TypeConverter::isCallable(obj);
    bool iterable = TypeConverter::isIterable(obj);
    bool asyncIterable = TypeConverter::isAsyncIterable(obj);
    bool isModule = TypeConverter::isModule(obj);
    bool isClass = TypeConverter::isClass(obj);
    bool isNone = obj == Py_None;

    std::ostringstream oss;
    oss << "{"
        << "\"typeName\":\"" << typeName << "\","
        << "\"qualName\":\"" << qualName << "\","
        << "\"isCallable\":" << (callable ? "true" : "false") << ","
        << "\"isIterable\":" << (iterable ? "true" : "false") << ","
        << "\"isAsyncIterable\":" << (asyncIterable ? "true" : "false") << ","
        << "\"isModule\":" << (isModule ? "true" : "false") << ","
        << "\"isClass\":" << (isClass ? "true" : "false") << ","
        << "\"isNone\":" << (isNone ? "true" : "false")
        << "}";

    TaskResult r;
    r.success = true;
    r.resultJson = oss.str();
    return r;
  });
}

/**
 * getObjectValue(objectId) -> Promise<result>
 */
static Napi::Value GetObjectValue(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  uint32_t objectId = info[0].As<Napi::Number>().Uint32Value();

  return SubmitTask(env, [objectId]() -> TaskResult {
    return PythonBridge::getInstance().getObjectValueSync(objectId);
  });
}

/**
 * getObjectRepr(objectId) -> Promise<string>
 */
static Napi::Value GetObjectRepr(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  uint32_t objectId = info[0].As<Napi::Number>().Uint32Value();

  auto deferred = Napi::Promise::Deferred::New(env);
  auto deferredPtr = std::make_shared<Napi::Promise::Deferred>(std::move(deferred));

  if (!g_initialized || !g_threadPool) {
    deferredPtr->Reject(Napi::Error::New(env, "pynect not initialized").Value());
    return deferredPtr->Promise();
  }

  g_threadPool->submit(
    [objectId]() -> TaskResult {
      GILAcquire gil;
      std::string repr = PythonBridge::getInstance().getObjectReprSync(objectId);
      TaskResult r;
      r.success = true;
      r.resultJson = "\"" + repr + "\"";
      return r;
    },
    [deferredPtr](TaskResult result) {
      Napi::Env callEnv = deferredPtr->Env();
      Napi::HandleScope scope(callEnv);
      if (result.success) {
        // Strip quotes
        std::string repr = result.resultJson;
        if (repr.size() >= 2 && repr.front() == '"') {
          repr = repr.substr(1, repr.size() - 2);
        }
        deferredPtr->Resolve(Napi::String::New(callEnv, repr));
      } else {
        deferredPtr->Reject(Napi::Error::New(callEnv, result.errorMessage).Value());
      }
    }
  );

  return deferredPtr->Promise();
}

/**
 * getObjectLength(objectId) -> Promise<number>
 */
static Napi::Value GetObjectLength(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  uint32_t objectId = info[0].As<Napi::Number>().Uint32Value();

  return SubmitTask(env, [objectId]() -> TaskResult {
    return PythonBridge::getInstance().getObjectLengthSync(objectId);
  });
}

/**
 * getObjectKeys(objectId) -> Promise<string[]>
 */
static Napi::Value GetObjectKeys(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  uint32_t objectId = info[0].As<Napi::Number>().Uint32Value();

  return SubmitTask(env, [objectId]() -> TaskResult {
    return PythonBridge::getInstance().getObjectKeysSync(objectId);
  });
}

/**
 * runPythonCode(code, globals?) -> Promise<result>
 */
static Napi::Value RunPythonCode(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string code = info[0].As<Napi::String>().Utf8Value();

  return SubmitTask(env, [code]() -> TaskResult {
    return PythonBridge::getInstance().runCodeSync(code);
  });
}

/**
 * evalPython(expression) -> Promise<result>
 */
static Napi::Value EvalPython(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string expression = info[0].As<Napi::String>().Utf8Value();

  return SubmitTask(env, [expression]() -> TaskResult {
    return PythonBridge::getInstance().evalExpressionSync(expression);
  });
}

/**
 * runPythonFile(filePath) -> Promise<result>
 */
static Napi::Value RunPythonFile(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string filePath = info[0].As<Napi::String>().Utf8Value();

  return SubmitTask(env, [filePath]() -> TaskResult {
    return PythonBridge::getInstance().runFileSync(filePath);
  });
}

/**
 * incRef(objectId) -> void
 */
static Napi::Value IncRef(const Napi::CallbackInfo& info) {
  uint32_t objectId = info[0].As<Napi::Number>().Uint32Value();
  TypeConverter::incRef(objectId);
  return info.Env().Undefined();
}

/**
 * decRef(objectId) -> void
 */
static Napi::Value DecRef(const Napi::CallbackInfo& info) {
  uint32_t objectId = info[0].As<Napi::Number>().Uint32Value();
  TypeConverter::decRef(objectId);
  return info.Env().Undefined();
}

/**
 * collectGarbage() -> Promise<void>
 */
static Napi::Value CollectGarbage(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  return SubmitTask(env, []() -> TaskResult {
    PythonBridge::getInstance().collectGarbage();
    TaskResult r;
    r.success = true;
    r.resultJson = "null";
    return r;
  });
}

/**
 * getMemoryStats() -> AddonMemoryStats (sync)
 */
static Napi::Value GetMemoryStats(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object result = Napi::Object::New(env);

  size_t trackedObjects = TypeConverter::getRegisteredCount();

  uint32_t activeThreads = g_threadPool ? g_threadPool->getActiveThreadCount() : 0;
  uint32_t queuedTasks = g_threadPool ? static_cast<uint32_t>(g_threadPool->getQueueSize()) : 0;

  // Python heap stats (approximate - would need pymalloc hooks for exact)
  result.Set("pythonHeapBytes", Napi::Number::New(env, 0));
  result.Set("pythonHeapPeakBytes", Napi::Number::New(env, 0));
  result.Set("trackedObjects", Napi::Number::New(env, static_cast<double>(trackedObjects)));
  result.Set("pendingCallbacks", Napi::Number::New(env, queuedTasks));
  result.Set("threadPoolActive", Napi::Number::New(env, activeThreads));
  result.Set("threadPoolQueued", Napi::Number::New(env, queuedTasks));

  return result;
}

/**
 * getProfilingReport() -> AddonProfilingReport (sync)
 */
static Napi::Value GetProfilingReport(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object result = Napi::Object::New(env);

  if (g_threadPool) {
    const auto& stats = g_threadPool->getStats();
    uint64_t total = stats.totalTasksCompleted.load() + stats.totalTasksFailed.load();
    uint64_t totalTimeUs = stats.totalExecutionTimeUs.load();
    double avgMs = total > 0 ? (static_cast<double>(totalTimeUs) / total / 1000.0) : 0.0;

    result.Set("totalCalls", Napi::Number::New(env, static_cast<double>(total)));
    result.Set("totalTimeMs", Napi::Number::New(env, static_cast<double>(totalTimeUs) / 1000.0));
    result.Set("avgCallTimeMs", Napi::Number::New(env, avgMs));
    result.Set("peakCallTimeMs", Napi::Number::New(env, 0));
    result.Set("callsByModule", Napi::Object::New(env));
    result.Set("callsByFunction", Napi::Object::New(env));
  } else {
    result.Set("totalCalls", Napi::Number::New(env, 0));
    result.Set("totalTimeMs", Napi::Number::New(env, 0));
    result.Set("avgCallTimeMs", Napi::Number::New(env, 0));
    result.Set("peakCallTimeMs", Napi::Number::New(env, 0));
    result.Set("callsByModule", Napi::Object::New(env));
    result.Set("callsByFunction", Napi::Object::New(env));
  }

  return result;
}

/**
 * setThreadPoolSize(size) -> Promise<void>
 */
static Napi::Value SetThreadPoolSize(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  uint32_t size = info[0].As<Napi::Number>().Uint32Value();

  if (g_threadPool) {
    g_threadPool->resize(size);
  }

  auto deferred = Napi::Promise::Deferred::New(env);
  deferred.Resolve(env.Undefined());
  return deferred.Promise();
}

/**
 * getThreadPoolStats() -> {active, queued, total}
 */
static Napi::Value GetThreadPoolStats(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object result = Napi::Object::New(env);

  if (g_threadPool) {
    result.Set("active", Napi::Number::New(env, g_threadPool->getActiveThreadCount()));
    result.Set("queued", Napi::Number::New(env, static_cast<double>(g_threadPool->getQueueSize())));
    result.Set("total", Napi::Number::New(env, g_threadPool->getThreadCount()));
  } else {
    result.Set("active", Napi::Number::New(env, 0));
    result.Set("queued", Napi::Number::New(env, 0));
    result.Set("total", Napi::Number::New(env, 0));
  }

  return result;
}

/**
 * createIterator(objectId, path[]) -> Promise<{iteratorId}>
 */
static Napi::Value CreateIterator(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  uint32_t objectId = info[0].As<Napi::Number>().Uint32Value();

  std::vector<std::string> path;
  if (info[1].IsArray()) {
    Napi::Array pathArr = info[1].As<Napi::Array>();
    for (uint32_t i = 0; i < pathArr.Length(); ++i) {
      path.push_back(pathArr.Get(i).As<Napi::String>().Utf8Value());
    }
  }

  return SubmitTask(env, [objectId, path]() -> TaskResult {
    return PythonBridge::getInstance().createIteratorSync(objectId, path);
  });
}

/**
 * iteratorNext(iteratorId) -> Promise<{done, value?}>
 */
static Napi::Value IteratorNext(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  uint32_t iteratorId = info[0].As<Napi::Number>().Uint32Value();

  return SubmitTask(env, [iteratorId]() -> TaskResult {
    return PythonBridge::getInstance().iteratorNextSync(iteratorId);
  });
}

/**
 * destroyIterator(iteratorId) -> Promise<void>
 */
static Napi::Value DestroyIterator(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  uint32_t iteratorId = info[0].As<Napi::Number>().Uint32Value();

  return SubmitTask(env, [iteratorId]() -> TaskResult {
    PythonBridge::getInstance().destroyIteratorSync(iteratorId);
    TaskResult r;
    r.success = true;
    r.resultJson = "null";
    return r;
  });
}

/**
 * resetProfilingStats() -> void
 */
static Napi::Value ResetProfilingStats(const Napi::CallbackInfo& info) {
  // Stats reset not implemented yet (would need atomic stores)
  return info.Env().Undefined();
}

// Module Registration

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  // Lifecycle
  exports.Set("initializePython",    Napi::Function::New(env, InitializePython));
  exports.Set("finalizePython",      Napi::Function::New(env, FinalizePython));
  exports.Set("isInitialized",       Napi::Function::New(env, IsInitialized));

  // Module import
  exports.Set("importModule",        Napi::Function::New(env, ImportModule));
  exports.Set("reloadModule",        Napi::Function::New(env, ReloadModule));

  // Attribute access
  exports.Set("getAttribute",        Napi::Function::New(env, GetAttribute));
  exports.Set("getAttributePath",    Napi::Function::New(env, GetAttributePath));
  exports.Set("setAttribute",        Napi::Function::New(env, SetAttribute));
  exports.Set("hasAttribute",        Napi::Function::New(env, HasAttribute));
  exports.Set("deleteAttribute",     Napi::Function::New(env, DeleteAttribute));

  // Function calls
  exports.Set("callFunction",        Napi::Function::New(env, CallFunction));
  exports.Set("callMethod",          Napi::Function::New(env, CallMethod));
  exports.Set("cancelCall",          Napi::Function::New(env, CancelCall));

  // Object inspection
  exports.Set("getTypeInfo",         Napi::Function::New(env, GetTypeInfo));
  exports.Set("getObjectValue",      Napi::Function::New(env, GetObjectValue));
  exports.Set("getObjectRepr",       Napi::Function::New(env, GetObjectRepr));
  exports.Set("getObjectLength",     Napi::Function::New(env, GetObjectLength));
  exports.Set("getObjectKeys",       Napi::Function::New(env, GetObjectKeys));

  // Iterator support
  exports.Set("createIterator",      Napi::Function::New(env, CreateIterator));
  exports.Set("iteratorNext",        Napi::Function::New(env, IteratorNext));
  exports.Set("destroyIterator",     Napi::Function::New(env, DestroyIterator));

  // Raw Python execution
  exports.Set("runPythonCode",       Napi::Function::New(env, RunPythonCode));
  exports.Set("runPythonFile",       Napi::Function::New(env, RunPythonFile));
  exports.Set("evalPython",          Napi::Function::New(env, EvalPython));

  // Object lifecycle
  exports.Set("incRef",              Napi::Function::New(env, IncRef));
  exports.Set("decRef",              Napi::Function::New(env, DecRef));
  exports.Set("collectGarbage",      Napi::Function::New(env, CollectGarbage));

  // Memory & diagnostics
  exports.Set("getMemoryStats",      Napi::Function::New(env, GetMemoryStats));
  exports.Set("getProfilingReport",  Napi::Function::New(env, GetProfilingReport));
  exports.Set("resetProfilingStats", Napi::Function::New(env, ResetProfilingStats));

  // Threading
  exports.Set("setThreadPoolSize",   Napi::Function::New(env, SetThreadPoolSize));
  exports.Set("getThreadPoolStats",  Napi::Function::New(env, GetThreadPoolStats));

  return exports;
}

} // namespace pynect

static Napi::Object InitPynect(Napi::Env env, Napi::Object exports) {
  return pynect::Init(env, exports);
}

NODE_API_MODULE(pynect_addon, InitPynect)
