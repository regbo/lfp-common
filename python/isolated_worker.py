"""JSON-lines worker for opt-in process-isolated Pynect calls."""

from __future__ import annotations

import contextlib
import datetime as dt
import enum
import importlib
import json
import os
import sys
import traceback
import uuid
from collections.abc import Mapping, Sequence
from typing import Any

import pynect_dispatcher as dispatcher


def _json_default(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    if hasattr(value, "dict"):
        return value.dict()
    if isinstance(value, enum.Enum):
        return value.value
    if isinstance(value, (dt.date, dt.datetime, dt.time)):
        return value.isoformat()
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, (set, frozenset, tuple)):
        return list(value)
    raise TypeError(f"Result is not JSON serializable: {type(value).__name__}")


def _resolve(module_name: str, function_name: str) -> Any:
    if not dispatcher.is_module_allowed(module_name):
        raise PermissionError(f"Python module is not allowed: {module_name}")
    parts = function_name.split(".")
    if not parts or any(not part or part.startswith("_") for part in parts):
        raise PermissionError(f"Private or invalid callable path: {function_name}")
    module = importlib.import_module(module_name)
    value: Any = module
    for part in parts:
        value = getattr(value, part)
    if not callable(value):
        raise TypeError(f"Python target is not callable: {module_name}.{function_name}")
    return value


def _handle(request: Mapping[str, Any]) -> Any:
    request_id = str(request.get("id", ""))
    module_name = str(request.get("module", ""))
    function_name = str(request.get("function", ""))
    args = request.get("args", [])
    kwargs = request.get("kwargs", {})
    timeout = int(request.get("executionTimeout", 0) or 0)
    if not isinstance(args, Sequence) or isinstance(args, (str, bytes, bytearray)):
        raise TypeError("args must be an array")
    if not isinstance(kwargs, Mapping):
        raise TypeError("kwargs must be an object")
    with contextlib.redirect_stdout(sys.stderr):
        function = _resolve(module_name, function_name)
        return dispatcher.invoke(function, list(args), dict(kwargs), request_id, timeout)


def main() -> None:
    config = json.loads(os.environ.get("PYNECT_DISPATCHER_CONFIG", "{}"))
    include_tracebacks = os.environ.get("PYNECT_INCLUDE_TRACEBACKS") == "1"
    dispatcher.configure(config)
    for raw_line in sys.stdin:
        request: Any = None
        try:
            request = json.loads(raw_line)
            request_id = request.get("id")
            result = _handle(request)
            response = {"id": request_id, "ok": True, "result": result}
        except BaseException as error:
            response = {
                "id": request.get("id") if isinstance(request, dict) else None,
                "ok": False,
                "error": {
                    "type": type(error).__name__,
                    "message": str(error),
                },
            }
            if include_tracebacks:
                response["error"]["traceback"] = traceback.format_exc()
        sys.stdout.write(json.dumps(response, default=_json_default, separators=(",", ":")) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
