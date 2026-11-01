"""
error_handler.py
================
Python-side exception handling and traceback formatting for pynect.

This module is the single place where Python exceptions are converted to
the structured error dict that ErrorTranslator.ts on the Node.js side
deserialises into ``PythonError`` instances.

Wire format

The dict returned by every public function in this module follows the shape
expected by the TypeScript ``PyErrorInfo`` interface:

.. code-block:: typescript

    interface PyErrorInfo {
      type:      string;   // Python exception class name
      message:   string;   // str(exc)
      traceback: string;   // formatted traceback (human-readable)
      frames:    FrameInfo[];
      cause:     PyErrorInfo | null;
      context:   PyErrorInfo | null;
      notes:     string[];     // PEP 678 __notes__  (Python 3.11+)
      pythonVersion: string;
    }

    interface FrameInfo {
      filename:  string;
      lineno:    number;
      name:      string;   // function / method name
      line:      string;   // source line (if available)
    }

Usage

The C++ addon calls ``handle_exception()`` inside every try/catch block that
wraps Python execution.  The result is forwarded as-is to the JavaScript layer.

Internal helpers like ``_extract_frames`` are also available to test code and
to pynect_runtime.py which calls ``_make_error_from_exc``.
"""

from __future__ import annotations

import sys
import os
import traceback
import linecache
from typing import Any, Dict, List, Optional, Tuple, Type

# Version for correlation in logs

ERROR_HANDLER_VERSION = "1.0.0"

# Exception type hierarchy
# Maps Python built-in exception names -> recommended JS error types.
# Used by ErrorTranslator.ts to select the right JS Error subclass.

EXCEPTION_CATEGORY: Dict[str, str] = {
    # Standard errors
    "TypeError":             "TypeError",
    "ValueError":            "RangeError",
    "IndexError":            "RangeError",
    "KeyError":              "ReferenceError",
    "AttributeError":        "TypeError",
    "NameError":             "ReferenceError",
    "ImportError":           "Error",
    "ModuleNotFoundError":   "Error",
    "SyntaxError":           "SyntaxError",
    "RuntimeError":          "Error",
    "NotImplementedError":   "Error",
    "StopIteration":         "Error",
    "GeneratorExit":         "Error",
    "OverflowError":         "RangeError",
    "ZeroDivisionError":     "RangeError",
    "MemoryError":           "Error",
    "RecursionError":        "RangeError",
    # IO
    "IOError":               "Error",
    "OSError":               "Error",
    "FileNotFoundError":     "Error",
    "FileExistsError":       "Error",
    "PermissionError":       "Error",
    "TimeoutError":          "Error",
    "ConnectionError":       "Error",
    "ConnectionResetError":  "Error",
    "ConnectionRefusedError": "Error",
    # Numeric
    "ArithmeticError":       "RangeError",
    "FloatingPointError":    "RangeError",
    # Pandas
    "KeyError":              "ReferenceError",
    "ParserError":           "SyntaxError",
    # General
    "AssertionError":        "Error",
    "SystemExit":            "Error",
    "KeyboardInterrupt":     "Error",
    "Exception":             "Error",
    "BaseException":         "Error",
}


# Public API

def handle_exception() -> Dict[str, Any]:
    """
    Capture the current exception (from sys.exc_info()) and return a
    structured error dict.

    Must be called from inside an ``except`` block.
    """
    exc_type, exc_value, exc_tb = sys.exc_info()
    if exc_value is None:
        # No active exception - shouldn't happen, but guard anyway
        return _make_plain_error("RuntimeError", "handle_exception() called with no active exception")
    return _build_error_dict(exc_type, exc_value, exc_tb)


def format_exception(
    exc: BaseException,
    *,
    include_cause: bool = True,
    include_context: bool = True,
    limit: int = 50,
) -> Dict[str, Any]:
    """
    Format an already-captured exception *exc* into the wire dict.

    Parameters
    ----------
    exc:
        The exception to format.
    include_cause:
        Whether to include the ``__cause__`` chain.
    include_context:
        Whether to include the ``__context__`` chain.
    limit:
        Maximum number of traceback frames to include.
    """
    exc_type = type(exc)
    exc_tb   = exc.__traceback__
    result   = _build_error_dict(exc_type, exc, exc_tb, limit=limit)

    if include_cause and exc.__cause__ is not None:
        result["cause"] = format_exception(
            exc.__cause__,
            include_cause=True,
            include_context=False,
            limit=limit,
        )

    if include_context and exc.__context__ is not None and not exc.__suppress_context__:
        result["context"] = format_exception(
            exc.__context__,
            include_cause=False,
            include_context=True,
            limit=limit,
        )

    return result


def make_error(
    exc_type: str,
    message:  str,
    tb:       str = "",
    *,
    frames:   Optional[List[Dict[str, Any]]] = None,
    cause:    Optional[Dict[str, Any]] = None,
    notes:    Optional[List[str]] = None,
) -> Dict[str, Any]:
    """
    Construct an error dict from primitive components.
    Used by pynect_runtime._make_error().
    """
    return {
        "error": {
            "type":          exc_type,
            "message":       message,
            "traceback":     tb,
            "frames":        frames or [],
            "cause":         cause,
            "context":       None,
            "notes":         notes or [],
            "pythonVersion": _python_version(),
            "jsErrorType":   EXCEPTION_CATEGORY.get(exc_type, "Error"),
        }
    }


# Traceback formatting

def extract_frames(
    tb: Optional[Any],
    limit: int = 50,
    skip_pynect_internals: bool = True,
) -> List[Dict[str, Any]]:
    """
    Convert a traceback object into a list of FrameInfo dicts.

    Parameters
    ----------
    tb:
        Traceback object from ``sys.exc_info()[2]``.
    limit:
        Maximum number of frames.
    skip_pynect_internals:
        If True, omit frames from pynect's own Python helpers.
    """
    if tb is None:
        return []

    frames: List[Dict[str, Any]] = []
    tb_list = traceback.extract_tb(tb, limit=limit)

    for frame in tb_list:
        filename = frame.filename or "<unknown>"
        name     = frame.name     or "<unknown>"
        lineno   = frame.lineno   or 0
        line     = (frame.line or "").strip()

        if skip_pynect_internals and _is_pynect_internal(filename):
            continue

        frames.append({
            "filename": os.path.abspath(filename) if filename != "<unknown>" else filename,
            "lineno":   lineno,
            "name":     name,
            "line":     line,
        })

    return frames


def format_traceback(
    tb: Optional[Any],
    exc_type: Optional[Type[BaseException]] = None,
    exc_value: Optional[BaseException] = None,
    limit: int = 50,
) -> str:
    """
    Return a human-readable traceback string (multi-line).
    Mirrors Python's built-in ``traceback.format_exception()``.
    """
    if tb is None and exc_value is not None:
        tb = exc_value.__traceback__
    if tb is None:
        if exc_value is not None:
            return f"{type(exc_value).__name__}: {exc_value}"
        return ""
    lines = traceback.format_exception(exc_type, exc_value, tb, limit=limit)
    return "".join(lines)


# Helpers used by the C++ addon directly

def safe_str(obj: Any) -> str:
    """
    Safely convert *obj* to str, catching any exceptions that __str__ might
    raise (common with misbehaving C extensions).
    """
    try:
        return str(obj)
    except Exception:
        try:
            return repr(obj)
        except Exception:
            return "<unrepresentable object>"


def classify_exception(exc: BaseException) -> Dict[str, str]:
    """
    Return a dict with ``type``, ``module``, ``jsErrorType`` for *exc*.
    Used by the C++ bridge to select behaviour before full serialization.
    """
    cls_name = type(exc).__name__
    module   = getattr(type(exc), '__module__', 'builtins') or 'builtins'
    return {
        "type":        cls_name,
        "module":      module,
        "jsErrorType": EXCEPTION_CATEGORY.get(cls_name, "Error"),
        "isBuiltin":   str(module in ('builtins', '__builtin__', 'exceptions')),
    }


def is_retriable(exc: BaseException) -> bool:
    """
    Return True if *exc* is a transient error that the caller may retry.
    Covers network timeouts, resource temporarily unavailable, etc.
    """
    cls_name = type(exc).__name__
    retriable = {
        "TimeoutError", "ConnectionResetError", "BrokenPipeError",
        "ConnectionAbortedError", "OSError",
    }
    if cls_name in retriable:
        return True
    msg = safe_str(exc).lower()
    return any(kw in msg for kw in ("timeout", "timed out", "resource temporarily unavailable"))


# Private helpers

def _build_error_dict(
    exc_type:  Optional[Type[BaseException]],
    exc_value: BaseException,
    exc_tb:    Optional[Any],
    limit:     int = 50,
) -> Dict[str, Any]:
    cls_name  = exc_type.__name__ if exc_type else type(exc_value).__name__
    message   = safe_str(exc_value)
    tb_str    = format_traceback(exc_tb, exc_type, exc_value, limit=limit)
    frames    = extract_frames(exc_tb, limit=limit)
    notes     = _get_notes(exc_value)

    return {
        "error": {
            "type":          cls_name,
            "message":       message,
            "traceback":     tb_str,
            "frames":        frames,
            "cause":         None,  # populated by format_exception if needed
            "context":       None,
            "notes":         notes,
            "pythonVersion": _python_version(),
            "jsErrorType":   EXCEPTION_CATEGORY.get(cls_name, "Error"),
        }
    }


def _make_plain_error(exc_type: str, message: str) -> Dict[str, Any]:
    return {
        "error": {
            "type":          exc_type,
            "message":       message,
            "traceback":     "",
            "frames":        [],
            "cause":         None,
            "context":       None,
            "notes":         [],
            "pythonVersion": _python_version(),
            "jsErrorType":   EXCEPTION_CATEGORY.get(exc_type, "Error"),
        }
    }


def _python_version() -> str:
    return f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"


def _get_notes(exc: BaseException) -> List[str]:
    """Return PEP 678 __notes__ if present (Python 3.11+)."""
    notes = getattr(exc, '__notes__', None)
    if isinstance(notes, list):
        return [safe_str(n) for n in notes]
    return []


def _is_pynect_internal(filename: str) -> bool:
    """Return True if *filename* belongs to pynect's own Python helpers."""
    if not filename:
        return False
    basename = os.path.basename(filename)
    pynect_files = {
        "pynect_runtime.py",
        "error_handler.py",
        "serializer.py",
        "type_inspector.py",
    }
    return basename in pynect_files


# Context managers

class catch_python_error:
    """
    Context manager that catches any exception and stores it as a wire dict.

    Usage::

        handler = catch_python_error()
        with handler:
            risky_operation()
        if handler.error:
            return handler.error   # forward to JS
    """

    def __init__(self) -> None:
        self.error: Optional[Dict[str, Any]] = None

    def __enter__(self) -> "catch_python_error":
        return self

    def __exit__(
        self,
        exc_type:  Optional[Type[BaseException]],
        exc_value: Optional[BaseException],
        exc_tb:    Optional[Any],
    ) -> bool:
        if exc_value is not None:
            self.error = _build_error_dict(exc_type, exc_value, exc_tb)
            return True  # suppress exception
        return False


# Structured logging helpers

def log_exception(exc: BaseException, context: str = "") -> None:
    """
    Print a structured exception summary to stderr.
    Used internally when errors cannot be forwarded to JS.
    """
    info = classify_exception(exc)
    prefix = f"[pynect] Exception in {context}: " if context else "[pynect] Exception: "
    print(f"{prefix}{info['type']}: {safe_str(exc)}", file=sys.stderr)
    if exc.__traceback__:
        tb_lines = traceback.format_tb(exc.__traceback__)
        for line in tb_lines:
            print(line.rstrip(), file=sys.stderr)


# Smoke test (run directly)

if __name__ == "__main__":
    # Quick sanity check
    try:
        1 / 0
    except ZeroDivisionError:
        err = handle_exception()
        import json
        print(json.dumps(err, indent=2, default=str))
