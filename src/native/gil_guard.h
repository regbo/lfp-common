/**
 * pynect - GIL Guard Header
 * RAII wrappers for the Python Global Interpreter Lock (GIL).
 *
 * The GIL ensures only one thread executes Python bytecode at a time.
 * These guards make GIL management safe via RAII idiom.
 */

#pragma once

#include <Python.h>
#include <stdexcept>

namespace pynect {

/**
 * GILAcquire - RAII guard that acquires the GIL on construction
 * and releases it on destruction.
 *
 * Use when Python code needs to run in a non-Python thread (e.g. a worker thread).
 * The calling thread must NOT already hold the GIL.
 *
 * @example
 * ```cpp
 * void worker_thread_func() {
 * GILAcquire gil;  // GIL acquired
 * PyObject* result = PyEval_EvalCode(...);
 * // GIL released when gil goes out of scope
 * }
 * ```
 */
class GILAcquire {
public:
  GILAcquire() noexcept : _state(PyGILState_Ensure()) {}
  ~GILAcquire() noexcept { PyGILState_Release(_state); }

  // Non-copyable, non-movable
  GILAcquire(const GILAcquire&) = delete;
  GILAcquire& operator=(const GILAcquire&) = delete;
  GILAcquire(GILAcquire&&) = delete;
  GILAcquire& operator=(GILAcquire&&) = delete;

private:
  PyGILState_STATE _state;
};

/**
 * GILRelease - RAII guard that releases the GIL on construction
 * and re-acquires it on destruction.
 *
 * Use to temporarily release the GIL while performing blocking I/O or
 * other operations that don't need Python, allowing other Python threads to run.
 * The calling thread MUST already hold the GIL.
 *
 * @example
 * ```cpp
 * // Inside Python-holding code:
 * {
 * GILRelease release;  // GIL released - other Python threads can run
 * perform_blocking_io();
 * }  // GIL re-acquired here
 * ```
 */
class GILRelease {
public:
  GILRelease() noexcept : _state(PyEval_SaveThread()) {}
  ~GILRelease() noexcept { PyEval_RestoreThread(_state); }

  // Non-copyable, non-movable
  GILRelease(const GILRelease&) = delete;
  GILRelease& operator=(const GILRelease&) = delete;
  GILRelease(GILRelease&&) = delete;
  GILRelease& operator=(GILRelease&&) = delete;

private:
  PyThreadState* _state;
};

/**
 * PyRef - RAII wrapper for PyObject* reference counting.
 *
 * Automatically calls Py_XDECREF on destruction.
 * Use steal() for objects returned from Python C API with new references.
 * Use borrow() for borrowed references (won't decref).
 */
class PyRef {
public:
  PyRef() noexcept : _obj(nullptr), _owned(false) {}

  ~PyRef() noexcept {
    reset();
  }

  /** Take ownership of an object (new reference from Python API) */
  static PyRef steal(PyObject* obj) noexcept {
    PyRef ref;
    ref._obj = obj;
    ref._owned = true;
    return ref;
  }

  /** Borrow a reference (will Py_INCREF and Py_DECREF) */
  static PyRef borrow(PyObject* obj) noexcept {
    PyRef ref;
    ref._obj = obj;
    ref._owned = false;
    if (obj) {
      Py_INCREF(obj);
      ref._owned = true;
    }
    return ref;
  }

  /** Increment reference count and get raw pointer */
  PyObject* incref() const noexcept {
    Py_XINCREF(_obj);
    return _obj;
  }

  /** Get raw pointer without changing reference count */
  PyObject* get() const noexcept { return _obj; }

  /** Release ownership without decrementing ref count */
  PyObject* release() noexcept {
    PyObject* obj = _obj;
    _obj = nullptr;
    _owned = false;
    return obj;
  }

  /** Reset - decrements ref count if owned */
  void reset() noexcept {
    if (_owned && _obj) {
      Py_DECREF(_obj);
    }
    _obj = nullptr;
    _owned = false;
  }

  /** Check if the object is valid (non-null) */
  explicit operator bool() const noexcept { return _obj != nullptr; }

  /** Check for Python exception state */
  bool hasException() const noexcept {
    return _obj == nullptr && PyErr_Occurred() != nullptr;
  }

  // Non-copyable
  PyRef(const PyRef&) = delete;
  PyRef& operator=(const PyRef&) = delete;

  // Movable
  PyRef(PyRef&& other) noexcept : _obj(other._obj), _owned(other._owned) {
    other._obj = nullptr;
    other._owned = false;
  }

  PyRef& operator=(PyRef&& other) noexcept {
    if (this != &other) {
      reset();
      _obj = other._obj;
      _owned = other._owned;
      other._obj = nullptr;
      other._owned = false;
    }
    return *this;
  }

private:
  PyObject* _obj;
  bool _owned;
};

} // namespace pynect
