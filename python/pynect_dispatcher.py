"""Policy and optional validation for calls crossing the embedded bridge.

The module intentionally imports Pydantic lazily. Applications that do not use
Pydantic keep the normal Python call semantics and do not need it installed.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import fnmatch
import inspect
import json
import threading
from collections.abc import Awaitable, Callable, Mapping, MutableMapping, Sequence
from typing import Any, get_type_hints

_CONFIG: dict[str, Any] = {
    "include": [],
    "exclude": [],
    "annotated_only": False,
    "exported_only": False,
    "validation": "auto",
}
_LOOP: asyncio.AbstractEventLoop | None = None
_LOOP_THREAD: threading.Thread | None = None
_LOOP_READY = threading.Event()
_LOOP_LOCK = threading.Lock()
_PENDING: dict[str, concurrent.futures.Future[Any]] = {}
_CANCELLED: set[str] = set()
_PENDING_LOCK = threading.Lock()


class DispatchPermissionError(PermissionError):
    """Raised when the configured selection policy rejects a call."""


class PydanticUnavailableError(RuntimeError):
    """Raised when validation is required but Pydantic is unavailable."""


def export(function: Callable[..., Any]) -> Callable[..., Any]:
    """Mark a callable for exported-only runtime and codegen policies."""

    setattr(function, "__pynect_export__", True)
    return function


def exclude(function: Callable[..., Any]) -> Callable[..., Any]:
    """Always exclude a callable from runtime calls and generated declarations."""

    setattr(function, "__pynect_exclude__", True)
    return function


def configure(options: Mapping[str, Any] | None = None) -> None:
    """Replace dispatcher policy with normalized, JSON-compatible options."""

    incoming = dict(options or {})
    validation = incoming.get("validation", "auto")
    if validation not in {"auto", "required", "off"}:
        raise ValueError("dispatcher.validation must be 'auto', 'required', or 'off'")
    _CONFIG.update(
        include=_patterns(incoming.get("include")),
        exclude=_patterns(incoming.get("exclude")),
        annotated_only=bool(incoming.get("annotatedOnly", False)),
        exported_only=bool(incoming.get("exportedOnly", False)),
        validation=validation,
    )


def is_module_allowed(module_name: str) -> bool:
    """Return whether importing a module can lead to an allowed callable."""

    if not _is_public_path(module_name) or _matches_any(module_name, _CONFIG["exclude"]):
        return False
    include: list[str] = _CONFIG["include"]
    if not include:
        return True
    return any(
        fnmatch.fnmatchcase(module_name, pattern)
        or pattern.startswith(f"{module_name}.")
        or pattern.startswith(f"{module_name}:")
        for pattern in include
    )


def invoke(
    function: Callable[..., Any],
    args: Sequence[Any],
    kwargs: Mapping[str, Any],
    request_id: str = "",
    execution_timeout_ms: int = 0,
) -> Any:
    """Authorize, optionally validate, execute, await, and validate one call."""

    if request_id and _consume_cancelled(request_id):
        raise asyncio.CancelledError(f"Python call was cancelled: {request_id}")
    qualified_name = _qualified_name(function)
    if not _callable_allowed(function, qualified_name):
        raise DispatchPermissionError(f"Python callable is not exported: {qualified_name}")

    signature = _safe_signature(function)
    hints = _safe_hints(function)
    bound = _bind(signature, args, kwargs) if signature is not None else None
    if bound is not None:
        bound.apply_defaults()
        _validate_arguments(signature, hints, bound.arguments)
        result = function(*bound.args, **bound.kwargs)
    else:
        result = function(*args, **kwargs)

    if inspect.isawaitable(result):
        result = _await(result, request_id, execution_timeout_ms)

    if request_id and _consume_cancelled(request_id):
        raise asyncio.CancelledError(f"Python call was cancelled: {request_id}")

    return_annotation = hints.get("return", inspect.Signature.empty)
    if return_annotation not in {inspect.Signature.empty, None, type(None)}:
        result = _validate_value(return_annotation, result, "return value", serialize=True)
    return result


def _bind(
    signature: inspect.Signature,
    args: Sequence[Any],
    kwargs: Mapping[str, Any],
) -> inspect.BoundArguments:
    try:
        return signature.bind(*args, **kwargs)
    except TypeError:
        positional = [
            parameter
            for parameter in signature.parameters.values()
            if parameter.name not in {"self", "cls"}
            and parameter.kind
            in {
                inspect.Parameter.POSITIONAL_ONLY,
                inspect.Parameter.POSITIONAL_OR_KEYWORD,
            }
        ]
        # The JavaScript proxy historically maps a trailing plain object to
        # kwargs. Recover the common Pydantic-model case where the Python
        # function actually declares one positional object parameter.
        if not args and kwargs and len(positional) == 1 and positional[0].name not in kwargs:
            return signature.bind(dict(kwargs))
        raise


def shutdown() -> None:
    """Stop the persistent asyncio loop when it was used."""

    global _LOOP, _LOOP_THREAD
    with _PENDING_LOCK:
        pending = list(_PENDING.values())
        _PENDING.clear()
        _CANCELLED.clear()
    for future in pending:
        future.cancel()
    with _LOOP_LOCK:
        loop = _LOOP
        thread = _LOOP_THREAD
        _LOOP = None
        _LOOP_THREAD = None
        _LOOP_READY.clear()
    if loop is not None:
        loop.call_soon_threadsafe(loop.stop)
    if thread is not None and thread is not threading.current_thread():
        thread.join(timeout=5)


def _callable_allowed(function: Callable[..., Any], qualified_name: str) -> bool:
    if getattr(function, "__pynect_exclude__", False):
        return False
    if not _is_public_path(qualified_name):
        return False
    if _matches_any(qualified_name, _CONFIG["exclude"]):
        return False
    include: list[str] = _CONFIG["include"]
    if include and not _matches_any(qualified_name, include):
        return False
    if _CONFIG["exported_only"] and not getattr(function, "__pynect_export__", False):
        return False
    if _CONFIG["annotated_only"] and not _fully_annotated(function):
        return False
    return True


def _fully_annotated(function: Callable[..., Any]) -> bool:
    if getattr(function, "__pynect_export__", False):
        return True
    signature = _safe_signature(function)
    if signature is None or signature.return_annotation is inspect.Signature.empty:
        return False
    return all(
        parameter.annotation is not inspect.Parameter.empty
        for parameter in signature.parameters.values()
        if parameter.name not in {"self", "cls"}
    )


def _validate_arguments(
    signature: inspect.Signature,
    hints: Mapping[str, Any],
    arguments: MutableMapping[str, Any],
) -> None:
    for name, value in list(arguments.items()):
        parameter = signature.parameters[name]
        annotation = hints.get(name, parameter.annotation)
        if annotation is inspect.Parameter.empty:
            continue
        if parameter.kind is inspect.Parameter.VAR_POSITIONAL:
            arguments[name] = tuple(
                _validate_value(annotation, item, f"argument '{name}'") for item in value
            )
        elif parameter.kind is inspect.Parameter.VAR_KEYWORD:
            arguments[name] = {
                key: _validate_value(annotation, item, f"argument '{name}.{key}'")
                for key, item in value.items()
            }
        else:
            arguments[name] = _validate_value(annotation, value, f"argument '{name}'")


def _validate_value(
    annotation: Any,
    value: Any,
    label: str,
    *,
    serialize: bool = False,
) -> Any:
    mode = _CONFIG["validation"]
    if mode == "off":
        return value
    try:
        import pydantic
    except ImportError:
        if mode == "required":
            raise PydanticUnavailableError(
                f"Pydantic validation is required but unavailable for {label}"
            )
        return value

    type_adapter = getattr(pydantic, "TypeAdapter", None)
    if type_adapter is not None:
        try:
            adapter = type_adapter(annotation)
        except Exception:
            if mode == "required":
                raise
            return value
        validated = adapter.validate_python(value)
        return adapter.dump_python(validated, mode="json") if serialize else validated

    parse_obj_as = getattr(pydantic, "parse_obj_as", None)
    if parse_obj_as is None:
        if mode == "required":
            raise PydanticUnavailableError(f"Pydantic does not support {label}")
        return value
    validated = parse_obj_as(annotation, value)
    if not serialize:
        return validated
    encoder = getattr(getattr(pydantic, "json", None), "pydantic_encoder", None)
    return json.loads(json.dumps(validated, default=encoder)) if encoder else validated


def cancel(request_id: str) -> bool:
    """Cancel a queued-to-loop coroutine or mark a not-yet-registered call."""

    if not request_id:
        return False
    with _PENDING_LOCK:
        future = _PENDING.get(request_id)
        if future is None:
            _CANCELLED.add(request_id)
            return True
    return future.cancel()


def _consume_cancelled(request_id: str) -> bool:
    with _PENDING_LOCK:
        if request_id not in _CANCELLED:
            return False
        _CANCELLED.remove(request_id)
        return True


def _await(value: Awaitable[Any], request_id: str, timeout_ms: int) -> Any:
    loop = _ensure_loop()

    async def resolve() -> Any:
        return await value

    future = asyncio.run_coroutine_threadsafe(resolve(), loop)
    if request_id:
        with _PENDING_LOCK:
            if request_id in _CANCELLED:
                _CANCELLED.remove(request_id)
                future.cancel()
            else:
                _PENDING[request_id] = future
    try:
        timeout = timeout_ms / 1000 if timeout_ms > 0 else None
        return future.result(timeout=timeout)
    except concurrent.futures.TimeoutError as error:
        future.cancel()
        raise TimeoutError(
            f"Python async call exceeded execution timeout of {timeout_ms}ms"
        ) from error
    except concurrent.futures.CancelledError as error:
        raise asyncio.CancelledError(
            f"Python async call was cancelled: {request_id or '<unknown>'}"
        ) from error
    finally:
        if request_id:
            with _PENDING_LOCK:
                _PENDING.pop(request_id, None)


def _ensure_loop() -> asyncio.AbstractEventLoop:
    global _LOOP, _LOOP_THREAD
    with _LOOP_LOCK:
        if _LOOP is not None and _LOOP.is_running():
            return _LOOP
        loop = asyncio.new_event_loop()
        _LOOP = loop

        def run() -> None:
            asyncio.set_event_loop(loop)
            _LOOP_READY.set()
            loop.run_forever()
            loop.close()

        _LOOP_THREAD = threading.Thread(
            target=run,
            name="pynect-asyncio",
            daemon=True,
        )
        _LOOP_THREAD.start()
    _LOOP_READY.wait(timeout=5)
    if _LOOP is None or not _LOOP.is_running():
        raise RuntimeError("Could not start the Pynect asyncio loop")
    return _LOOP


def _qualified_name(function: Callable[..., Any]) -> str:
    module = getattr(function, "__module__", "")
    name = getattr(function, "__qualname__", getattr(function, "__name__", "<callable>"))
    return f"{module}.{name}" if module else name


def _safe_signature(function: Callable[..., Any]) -> inspect.Signature | None:
    try:
        return inspect.signature(function)
    except (TypeError, ValueError):
        return None


def _safe_hints(function: Callable[..., Any]) -> dict[str, Any]:
    try:
        return get_type_hints(function, include_extras=True)
    except Exception:
        return dict(getattr(function, "__annotations__", {}))


def _patterns(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    return [str(item) for item in value]


def _matches_any(value: str, patterns: Sequence[str]) -> bool:
    leaf = value.rsplit(".", 1)[-1]
    return any(
        fnmatch.fnmatchcase(value, pattern) or fnmatch.fnmatchcase(leaf, pattern)
        for pattern in patterns
    )


def _is_public_path(value: str) -> bool:
    return all(not part.startswith("_") for part in value.replace(":", ".").split("."))
