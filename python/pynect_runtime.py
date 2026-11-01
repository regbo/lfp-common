"""
pynect_runtime.py
=================
Python-side runtime helper that is imported by PyRuntime._initialize() via the
C++ N-API addon.  This module provides the bridge between the embedded CPython
interpreter and the JavaScript layer.

Responsibilities

  - Initialize Python-side state (sys.path, codec registration, etc.)
  - Expose object reference management (id -> object registry)
  - Resolve attribute chains  (obj, ["attr1", "attr2", "method"])
  - Call callables with positional / keyword arguments
  - Build and iterate Python iterators
  - Set attributes on Python objects
  - Serialize return values to the wire format expected by serializer.ts
  - Handle exceptions and forward structured error information
  - Provide module introspection used by TypeGenerator.ts

Thread safety

  All functions in this module are called from the C++ thread pool while the
  GIL is held.  Because the GIL serialises access there is no need for
  additional locking inside Python.

Wire protocol

  The serialization module (serializer.py) is imported lazily and its
  ``serialize`` function is the single exit point for Python values heading
  back to JavaScript.  The C++ layer receives a Python dict that matches the
  SerializedValue TypeScript interface.
"""

from __future__ import annotations

import sys
import os
import importlib
import inspect
import traceback
import weakref
import threading
from typing import Any, Dict, List, Optional, Tuple, Union

# Version

PYNECT_RUNTIME_VERSION = "1.0.0"

# Object Registry
# Maps integer object-ids that cross the JS/Python boundary to live Python
# objects.  We use a plain dict of strong references here because Python
# objects must NOT be garbage-collected while JS holds a PyProxy to them.
# The C++ addon calls ``release_object`` when the corresponding JS Proxy is
# garbage-collected via FinalizationRegistry.

_registry: Dict[int, Any] = {}
_registry_lock = threading.Lock()
_next_id = 1


def _register(obj: Any) -> int:
    """Store *obj* in the registry and return its numeric id."""
    global _next_id
    with _registry_lock:
        oid = _next_id
        _next_id += 1
        _registry[oid] = obj
        return oid


def _lookup(oid: int) -> Any:
    """Retrieve the object for *oid* or raise KeyError."""
    with _registry_lock:
        return _registry[oid]


def release_object(oid: int) -> None:
    """
    Remove the object associated with *oid* from the registry.
    Called by the C++ FinalizationRegistry callback when the JS Proxy dies.
    """
    with _registry_lock:
        _registry.pop(oid, None)


def registry_size() -> int:
    """Return the number of live objects in the registry (diagnostic)."""
    with _registry_lock:
        return len(_registry)


# Initialization

_initialized = False


def initialize(extra_paths: Optional[List[str]] = None) -> None:
    """
    Called once by PyRuntime._initialize().

    - Ensures the pynect python/ directory is on sys.path.
    - Registers the msgpack extension codec (if msgpack is available).
    - Sets UTF-8 as the default stdout/stderr encoding.
    - Performs any one-time setup required by the serializer.
    """
    global _initialized
    if _initialized:
        return

    # Make sure the python/ directory is importable
    runtime_dir = os.path.dirname(os.path.abspath(__file__))
    if runtime_dir not in sys.path:
        sys.path.insert(0, runtime_dir)

    if extra_paths:
        for p in extra_paths:
            if p not in sys.path:
                sys.path.insert(0, p)

    # Force UTF-8 output (avoids encoding errors with Python 3.6)
    try:
        if hasattr(sys.stdout, 'reconfigure'):
            sys.stdout.reconfigure(encoding='utf-8', errors='replace')  # type: ignore[attr-defined]
        if hasattr(sys.stderr, 'reconfigure'):
            sys.stderr.reconfigure(encoding='utf-8', errors='replace')  # type: ignore[attr-defined]
    except Exception:
        pass  # non-fatal

    _initialized = True


# Module import

def import_module(module_name: str) -> Dict[str, Any]:
    """
    Import *module_name* and return a wire-format dict.

    Returns
    -------
    {"type": "python_object", "objectId": <int>}
    on success, or an error dict on failure.
    """
    try:
        mod = importlib.import_module(module_name)
        oid = _register(mod)
        return {"type": "python_object", "objectId": oid}
    except ImportError as exc:
        return _make_error("ImportError", str(exc), traceback.format_exc())
    except Exception as exc:
        return _make_error(type(exc).__name__, str(exc), traceback.format_exc())


# Attribute resolution

def resolve_attribute_path(oid: int, path: List[str]) -> Dict[str, Any]:
    """
    Starting from the registered object *oid*, follow the attribute chain
    described by *path* and return the final value serialized for the wire.

    Example: oid -> pandas module, path=["DataFrame","from_dict"]
    Returns a reference to the unbound method DataFrame.from_dict.
    """
    try:
        obj = _lookup(oid)
        for attr in path:
            obj = getattr(obj, attr)
        return _serialize_result(obj)
    except AttributeError as exc:
        return _make_error("AttributeError", str(exc), traceback.format_exc())
    except Exception as exc:
        return _make_error(type(exc).__name__, str(exc), traceback.format_exc())


def get_object_value(oid: int) -> Dict[str, Any]:
    """Serialize the registered object *oid* for transfer to JS."""
    try:
        obj = _lookup(oid)
        return _serialize_result(obj)
    except Exception as exc:
        return _make_error(type(exc).__name__, str(exc), traceback.format_exc())


def set_attribute(oid: int, attr_name: str, serialized_value: Dict[str, Any]) -> Dict[str, Any]:
    """
    Set ``obj.attr_name = value`` where *obj* is the registered object for
    *oid* and *value* is deserialized from *serialized_value*.
    """
    try:
        from serializer import deserialize as _deser  # lazy import
        obj   = _lookup(oid)
        value = _deser(serialized_value)
        setattr(obj, attr_name, value)
        return {"type": "null", "data": "null"}
    except Exception as exc:
        return _make_error(type(exc).__name__, str(exc), traceback.format_exc())


# Function / method call

def call_function(
    oid:             int,
    path:            List[str],
    serialized_args: List[Dict[str, Any]],
    serialized_kwargs: Optional[Dict[str, Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """
    Resolve ``obj.path[0].path[1]....`` starting from *oid*, then call it with
    the provided positional arguments (deserialized from *serialized_args*) and
    keyword arguments (deserialized from *serialized_kwargs*).

    All arguments are deserialized via serializer.deserialize().
    The return value is serialized via _serialize_result().
    """
    from serializer import deserialize as _deser  # lazy import

    try:
        obj = _lookup(oid)
        for attr in path:
            obj = getattr(obj, attr)

        if not callable(obj):
            return _make_error(
                "TypeError",
                f"Object at path {path!r} is not callable (got {type(obj).__name__})",
                ""
            )

        args   = [_deser(a) for a in serialized_args]
        kwargs = {k: _deser(v) for k, v in (serialized_kwargs or {}).items()}

        result = obj(*args, **kwargs)
        return _serialize_result(result)

    except Exception as exc:
        return _make_error(type(exc).__name__, str(exc), traceback.format_exc())


def eval_code(code: str, globals_oid: Optional[int] = None) -> Dict[str, Any]:
    """
    Execute *code* with ``eval()`` (single expression) or ``exec()``
    (statements) and return the result.

    If *globals_oid* is given, use the registered dict as the global namespace.
    """
    try:
        g: Dict[str, Any] = _lookup(globals_oid) if globals_oid is not None else {}
        # Try eval first for expressions
        try:
            result = eval(code, g)  # noqa: S307
        except SyntaxError:
            exec(code, g)           # noqa: S102
            result = None
        return _serialize_result(result)
    except Exception as exc:
        return _make_error(type(exc).__name__, str(exc), traceback.format_exc())


def run_code(code: str, namespace: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Execute *code* as a statement block (exec) and return the namespace.
    Useful for multi-line setup scripts.
    """
    try:
        ns: Dict[str, Any] = namespace or {}
        exec(code, ns)  # noqa: S102
        return {"type": "null", "data": "null"}
    except Exception as exc:
        return _make_error(type(exc).__name__, str(exc), traceback.format_exc())


# Iterator support

_iterators: Dict[int, Any] = {}
_iter_lock  = threading.Lock()
_iter_next_id = 1


def create_iterator(oid: int, path: List[str]) -> Dict[str, Any]:
    """
    Build a Python iterator from the object at oid.path and register it.
    Returns {"iteratorId": <int>}.
    """
    global _iter_next_id
    try:
        obj = _lookup(oid)
        for attr in path:
            obj = getattr(obj, attr)
        it = iter(obj)
        with _iter_lock:
            iter_id = _iter_next_id
            _iter_next_id += 1
            _iterators[iter_id] = it
        return {"iteratorId": iter_id}
    except Exception as exc:
        return _make_error(type(exc).__name__, str(exc), traceback.format_exc())


def iterator_next(iter_id: int) -> Dict[str, Any]:
    """
    Advance the iterator and return the next value.
    Returns {"done": true} when exhausted.
    """
    with _iter_lock:
        it = _iterators.get(iter_id)
    if it is None:
        return _make_error("RuntimeError", f"No iterator with id {iter_id}", "")
    try:
        value = next(it)
        return {"done": False, "value": _serialize_result(value)}
    except StopIteration:
        return {"done": True}
    except Exception as exc:
        return _make_error(type(exc).__name__, str(exc), traceback.format_exc())


def destroy_iterator(iter_id: int) -> None:
    """Release the iterator registered under *iter_id*."""
    with _iter_lock:
        _iterators.pop(iter_id, None)


# Module introspection

def inspect_module(module_name: str) -> List[Dict[str, Any]]:
    """
    Introspect *module_name* and return a list of RawModuleInspection-shaped
    dicts. This is consumed by codegen to produce TypeScript declarations.

    Delegates to type_inspector.inspect_module if available.
    """
    try:
        # Prefer the dedicated inspector
        from type_inspector import inspect_module as _inspect  # type: ignore
        return _inspect(module_name)
    except ImportError:
        pass

    # Minimal fallback
    try:
        mod = importlib.import_module(module_name)
    except ImportError as exc:
        return [{"error": str(exc)}]

    results: List[Dict[str, Any]] = []
    for name, obj in inspect.getmembers(mod):
        if name.startswith('_'):
            continue
        entry: Dict[str, Any] = {
            "name":      name,
            "docstring": inspect.getdoc(obj) or "",
        }
        if inspect.isfunction(obj) or inspect.isbuiltin(obj):
            entry["type"] = "function"
            try:
                sig = inspect.signature(obj)
                entry["parameters"] = [
                    {
                        "name":     pname,
                        "type":     _annotation_to_str(p.annotation),
                        "optional": p.default is not inspect.Parameter.empty,
                    }
                    for pname, p in sig.parameters.items()
                    if pname != "self"
                ]
                entry["returnType"] = _annotation_to_str(sig.return_annotation)
            except (ValueError, TypeError):
                entry["parameters"] = []
                entry["returnType"] = "Any"
        elif inspect.isclass(obj):
            entry["type"] = "class"
            entry["properties"] = {
                attr: "Any"
                for attr in dir(obj)
                if not attr.startswith('_')
            }
        else:
            entry["type"]      = "value"
            entry["valueType"] = type(obj).__name__
        results.append(entry)
    return results


def _annotation_to_str(ann: Any) -> str:
    if ann is inspect.Parameter.empty:
        return "Any"
    if hasattr(ann, '__name__'):
        return ann.__name__
    return str(ann).replace("typing.", "")


# Serialization helpers

def _serialize_result(obj: Any) -> Dict[str, Any]:
    """
    Serialize *obj* to a wire dict.

    Attempts to use the full serializer.  Falls back to a simple primitive
    check if the serializer is not yet available (early boot).
    """
    try:
        from serializer import serialize  # lazy import
        return serialize(obj)
    except ImportError:
        pass

    # Minimal primitive fallback (used during early initialization)
    import json
    if obj is None:
        return {"format": "json", "data": "null"}
    if isinstance(obj, (bool, int, float, str)):
        return {"format": "json", "data": json.dumps(obj)}
    if isinstance(obj, (list, dict)):
        try:
            return {"format": "json", "data": json.dumps(obj)}
        except (TypeError, ValueError):
            pass
    # Non-serializable -> register as Python object reference
    oid = _register(obj)
    return {"format": "python_ref", "data": None, "metadata": {"objectId": oid}}


def _make_error(exc_type: str, message: str, tb: str) -> Dict[str, Any]:
    """Build a structured error dict forwarded to error-translator.ts."""
    return {
        "error": {
            "type":      exc_type,
            "message":   message,
            "traceback": tb,
        }
    }


# Diagnostic helpers

def get_python_info() -> Dict[str, Any]:
    """Return basic Python interpreter information (used by PythonDetector)."""
    import platform
    return {
        "version":      sys.version,
        "version_info": list(sys.version_info[:3]),
        "executable":   sys.executable,
        "prefix":       sys.prefix,
        "platform":     sys.platform,
        "machine":      platform.machine(),
        "is_venv":      hasattr(sys, 'real_prefix') or (
            hasattr(sys, 'base_prefix') and sys.base_prefix != sys.prefix
        ),
    }


def get_installed_packages() -> List[Dict[str, str]]:
    """
    Return a list of {name, version} dicts for all installed packages.
    Uses importlib.metadata (Python 3.8+) or pkg_resources as fallback.
    """
    try:
        import importlib.metadata as imeta
        return [
            {"name": d.metadata['Name'], "version": d.version}
            for d in imeta.distributions()
        ]
    except Exception:
        pass
    try:
        import pkg_resources
        return [
            {"name": pkg.project_name, "version": pkg.version}
            for pkg in pkg_resources.working_set
        ]
    except Exception:
        return []


def check_module_importable(module_name: str) -> bool:
    """Return True if *module_name* can be imported without error."""
    try:
        importlib.import_module(module_name)
        return True
    except ImportError:
        return False


def get_module_version(module_name: str) -> Optional[str]:
    """Return the installed version of *module_name*, or None."""
    try:
        import importlib.metadata as imeta
        return imeta.version(module_name)
    except Exception:
        pass
    try:
        mod = importlib.import_module(module_name)
        for attr in ('__version__', 'VERSION', 'version'):
            v = getattr(mod, attr, None)
            if v is not None:
                return str(v)
    except Exception:
        pass
    return None


# Context / namespace management

def create_namespace(init_code: Optional[str] = None) -> Dict[str, Any]:
    """
    Create an isolated execution namespace (analogous to py-context.ts).
    Returns {"namespaceId": <oid>}.
    """
    ns: Dict[str, Any] = {"__builtins__": __builtins__}
    if init_code:
        exec(init_code, ns)  # noqa: S102
    oid = _register(ns)
    return {"namespaceId": oid}


def exec_in_namespace(namespace_oid: int, code: str) -> Dict[str, Any]:
    """Execute *code* inside the namespace registered as *namespace_oid*."""
    try:
        ns = _lookup(namespace_oid)
        exec(code, ns)  # noqa: S102
        return {"type": "null", "data": "null"}
    except Exception as exc:
        return _make_error(type(exc).__name__, str(exc), traceback.format_exc())


def eval_in_namespace(namespace_oid: int, expression: str) -> Dict[str, Any]:
    """Evaluate *expression* inside the namespace and return the result."""
    try:
        ns = _lookup(namespace_oid)
        result = eval(expression, ns)  # noqa: S307
        return _serialize_result(result)
    except Exception as exc:
        return _make_error(type(exc).__name__, str(exc), traceback.format_exc())


def get_namespace_keys(namespace_oid: int) -> List[str]:
    """Return the list of names defined in the namespace (excluding builtins)."""
    try:
        ns = _lookup(namespace_oid)
        return [k for k in ns if not k.startswith('__')]
    except Exception:
        return []


# Async / generator utilities

def create_generator(oid: int, path: List[str], *args: Any) -> Dict[str, Any]:
    """
    Call the callable at oid.path with *args* and expect it to be a generator
    function.  Registers the resulting generator and returns its id.
    """
    try:
        obj = _lookup(oid)
        for attr in path:
            obj = getattr(obj, attr)
        gen = obj(*args)
        if not hasattr(gen, '__next__'):
            return _make_error("TypeError", "Not a generator function", "")
        oid_gen = _register(gen)
        return {"generatorId": oid_gen}
    except Exception as exc:
        return _make_error(type(exc).__name__, str(exc), traceback.format_exc())


# Cleanup

def shutdown() -> None:
    """
    Called by PyRuntime.shutdown() before Py_Finalize().
    Clears the object registry and iterator table to allow GC to run cleanly.
    """
    with _registry_lock:
        _registry.clear()
    with _iter_lock:
        _iterators.clear()
