from __future__ import annotations

import asyncio
import concurrent.futures
import dataclasses
import datetime as dt
import enum
import hmac
import importlib
import importlib.util
import inspect
import os
import socket
import sys
import threading
import time
import traceback
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Callable, get_type_hints

import msgpack


PROTOCOL_VERSION = 1
MAX_FRAME_BYTES = 256 * 1024 * 1024
WIRE_TYPE = "__pynect_wire_type__"


class JavaScriptError(RuntimeError):
    pass


class ObjectRegistry:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._next_id = 1
        self._objects: dict[int, Any] = {}

    def add(self, value: Any) -> int:
        with self._lock:
            object_id = self._next_id
            self._next_id += 1
            self._objects[object_id] = value
            return object_id

    def get(self, object_id: int) -> Any:
        with self._lock:
            try:
                return self._objects[object_id]
            except KeyError as error:
                raise ReferenceError(f"Python object #{object_id} has been released") from error

    def release(self, object_id: int) -> None:
        with self._lock:
            self._objects.pop(object_id, None)

    def clear(self) -> None:
        with self._lock:
            self._objects.clear()


class AsyncRuntime:
    def __init__(self) -> None:
        self._loop = asyncio.new_event_loop()
        self._ready = threading.Event()
        self._thread = threading.Thread(
            target=self._run,
            name="pynect-asyncio",
            daemon=True,
        )
        self._thread.start()
        if not self._ready.wait(timeout=5):
            raise RuntimeError("Could not start the Python asyncio runtime")

    def _run(self) -> None:
        asyncio.set_event_loop(self._loop)
        self._ready.set()
        self._loop.run_forever()

    def resolve(self, value: Any) -> Any:
        if not inspect.isawaitable(value):
            return value

        async def await_value() -> Any:
            return await value

        return asyncio.run_coroutine_threadsafe(await_value(), self._loop).result()

    def close(self) -> None:
        self._loop.call_soon_threadsafe(self._loop.stop)
        self._thread.join(timeout=2)
        if not self._loop.is_closed():
            self._loop.close()


class PydanticValidator:
    def __init__(self, enabled: bool) -> None:
        self.enabled = enabled
        self._pydantic: Any | None = None
        if enabled:
            try:
                import pydantic

                self._pydantic = pydantic
            except ImportError:
                pass

    def arguments(
        self,
        function: Callable[..., Any],
        args: list[Any],
        kwargs: dict[str, Any],
    ) -> tuple[list[Any], dict[str, Any]]:
        if self._pydantic is None:
            return args, kwargs
        try:
            signature = inspect.signature(function)
            hints = get_type_hints(function, include_extras=True)
        except (NameError, TypeError, ValueError):
            return args, kwargs

        bound = signature.bind(*args, **kwargs)
        bound.apply_defaults()
        for name, value in list(bound.arguments.items()):
            parameter = signature.parameters[name]
            annotation = hints.get(name, parameter.annotation)
            if annotation is inspect.Parameter.empty:
                continue
            if parameter.kind is inspect.Parameter.VAR_POSITIONAL:
                bound.arguments[name] = tuple(
                    self._validate(annotation, item) for item in value
                )
            elif parameter.kind is inspect.Parameter.VAR_KEYWORD:
                bound.arguments[name] = {
                    key: self._validate(annotation, item)
                    for key, item in value.items()
                }
            else:
                bound.arguments[name] = self._validate(annotation, value)
        return list(bound.args), dict(bound.kwargs)

    def _validate(self, annotation: Any, value: Any) -> Any:
        type_adapter = getattr(self._pydantic, "TypeAdapter", None)
        if type_adapter is not None:
            return type_adapter(annotation).validate_python(value)
        parse_obj_as = getattr(self._pydantic, "parse_obj_as", None)
        return parse_obj_as(annotation, value) if parse_obj_as else value


class FramedConnection:
    def __init__(self, endpoint: str) -> None:
        self._write_lock = threading.Lock()
        self._socket: socket.socket | None = None
        self._pipe_handle: int | None = None
        if os.name == "nt":
            self._pipe_handle = self._open_windows_pipe(endpoint)
        else:
            connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            connection.connect(endpoint)
            self._socket = connection

    @staticmethod
    def _open_windows_pipe(endpoint: str) -> int:
        import _winapi

        deadline = time.monotonic() + 10
        while True:
            try:
                _winapi.WaitNamedPipe(endpoint, 1000)
                return _winapi.CreateFile(
                    endpoint,
                    _winapi.GENERIC_READ | _winapi.GENERIC_WRITE,
                    0,
                    _winapi.NULL,
                    _winapi.OPEN_EXISTING,
                    _winapi.FILE_FLAG_OVERLAPPED,
                    _winapi.NULL,
                )
            except OSError as error:
                if time.monotonic() >= deadline:
                    raise
                if error.winerror not in {
                    _winapi.ERROR_PIPE_BUSY,
                    _winapi.ERROR_SEM_TIMEOUT,
                }:
                    raise
                time.sleep(0.025)

    def read(self) -> dict[str, Any] | None:
        header = self._read_exact(4)
        if header is None:
            return None
        length = int.from_bytes(header, "big")
        if length > MAX_FRAME_BYTES:
            raise ValueError(f"RPC frame exceeds {MAX_FRAME_BYTES} bytes")
        payload = self._read_exact(length)
        if payload is None:
            raise EOFError("IPC connection closed inside a frame")
        value = msgpack.unpackb(payload, raw=False, strict_map_key=False)
        if not isinstance(value, dict):
            raise TypeError("RPC message must be a map")
        return value

    def write(self, message: dict[str, Any]) -> None:
        payload = msgpack.packb(message, use_bin_type=True)
        if len(payload) > MAX_FRAME_BYTES:
            raise ValueError(f"RPC frame exceeds {MAX_FRAME_BYTES} bytes")
        frame = len(payload).to_bytes(4, "big") + payload
        with self._write_lock:
            if self._pipe_handle is not None:
                self._write_windows(frame)
                return
            if self._socket is not None:
                self._socket.sendall(frame)
                return
            raise EOFError("IPC connection is closed")

    def _read_exact(self, length: int) -> bytes | None:
        chunks: list[bytes] = []
        remaining = length
        while remaining:
            chunk = (
                self._socket.recv(remaining)
                if self._socket is not None
                else self._read_windows(remaining)
            )
            if not chunk:
                if not chunks:
                    return None
                raise EOFError("IPC connection closed during read")
            chunks.append(bytes(chunk))
            remaining -= len(chunk)
        return b"".join(chunks)

    def _read_windows(self, length: int) -> bytes:
        import _winapi

        try:
            overlapped, _ = _winapi.ReadFile(
                self._pipe_handle,
                length,
                overlapped=True,
            )
            overlapped.GetOverlappedResult(True)
            return bytes(overlapped.getbuffer())
        except OSError as error:
            if error.winerror == _winapi.ERROR_BROKEN_PIPE:
                return b""
            raise

    def _write_windows(self, value: bytes) -> None:
        import _winapi

        overlapped, _ = _winapi.WriteFile(
            self._pipe_handle,
            value,
            overlapped=True,
        )
        written, error = overlapped.GetOverlappedResult(True)
        if error:
            raise OSError(error, "Windows named pipe write failed")
        if written != len(value):
            raise EOFError("Windows named pipe closed during write")

    def close(self) -> None:
        if self._socket is not None:
            self._socket.close()
        if self._pipe_handle is not None:
            import _winapi

            _winapi.CloseHandle(self._pipe_handle)
            self._pipe_handle = None


@dataclasses.dataclass
class PendingCallback:
    event: threading.Event = dataclasses.field(default_factory=threading.Event)
    message: dict[str, Any] | None = None


class JavaScriptCallback:
    def __init__(self, bridge: "Bridge", callback_id: int) -> None:
        self._bridge = bridge
        self._callback_id = callback_id

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        return self._bridge.invoke_callback(self._callback_id, list(args), kwargs)


class Bridge:
    def __init__(
        self,
        connection: FramedConnection,
        token: str,
        validate_pydantic: bool,
    ) -> None:
        self.connection = connection
        self.token = token
        self.registry = ObjectRegistry()
        self.async_runtime = AsyncRuntime()
        self.validator = PydanticValidator(validate_pydantic)
        self._stopped = threading.Event()
        self._callback_lock = threading.Lock()
        self._next_callback_id = 1
        self._pending_callbacks: dict[int, PendingCallback] = {}
        self._callbacks: dict[int, JavaScriptCallback] = {}
        worker_count = min(32, (os.cpu_count() or 1) + 4)
        self._executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=worker_count,
            thread_name_prefix="pynect-call",
        )

    def run(self) -> None:
        self.connection.write(
            {"kind": "hello", "protocol": PROTOCOL_VERSION, "token": self.token}
        )
        try:
            while not self._stopped.is_set():
                message = self.connection.read()
                if message is None:
                    break
                self._dispatch_message(message)
        finally:
            self._stopped.set()
            with self._callback_lock:
                pending = list(self._pending_callbacks.values())
                self._pending_callbacks.clear()
            for callback in pending:
                callback.message = {
                    "ok": False,
                    "error": {
                        "message": "JavaScript host disconnected",
                        "type": "ConnectionError",
                    },
                }
                callback.event.set()
            self._executor.shutdown(wait=False, cancel_futures=True)
            self.async_runtime.close()
            self.registry.clear()
            self.connection.close()

    def _dispatch_message(self, message: dict[str, Any]) -> None:
        kind = message.get("kind")
        if kind == "callback_result":
            self._resolve_callback(message)
            return
        if kind not in {"request", "notify"}:
            raise TypeError(f"Unknown RPC message kind: {kind}")
        operation = str(message.get("op", ""))
        if operation == "shutdown" and kind == "request":
            self.connection.write(
                {
                    "id": message.get("id"),
                    "kind": "response",
                    "ok": True,
                    "value": None,
                }
            )
            self._stopped.set()
            return
        self._executor.submit(self._handle_request, message)

    def _handle_request(self, message: dict[str, Any]) -> None:
        request_id = message.get("id")
        expects_response = message.get("kind") == "request"
        try:
            payload = decode_wire(message.get("payload", {}), self)
            if not isinstance(payload, dict):
                raise TypeError("RPC request payload must be a map")
            result = self._operate(str(message.get("op", "")), payload)
            if expects_response:
                self.connection.write(
                    {
                        "id": request_id,
                        "kind": "response",
                        "ok": True,
                        "value": encode_wire(result, self),
                    }
                )
        except BaseException as error:
            if expects_response:
                self.connection.write(
                    {
                        "error": {
                            "message": str(error),
                            "traceback": traceback.format_exc(),
                            "type": type(error).__name__,
                        },
                        "id": request_id,
                        "kind": "response",
                        "ok": False,
                    }
                )

    def _operate(self, operation: str, payload: dict[str, Any]) -> Any:
        if operation == "import":
            return import_python_module(str(payload["name"]))
        target = self.registry.get(int(payload["target"]))
        path = [str(part) for part in payload.get("path", [])]
        value = resolve_path(target, path)
        if operation == "get":
            return value
        if operation == "set":
            if not path:
                raise TypeError("Setting a root Python reference is not supported")
            parent = resolve_path(target, path[:-1])
            setattr(parent, path[-1], payload.get("value"))
            return None
        if operation == "call":
            if not callable(value):
                raise TypeError(f"{type(value).__name__} object is not callable")
            args = list(payload.get("args", []))
            kwargs = dict(payload.get("kwargs", {}))
            args, kwargs = self.validator.arguments(value, args, kwargs)
            return self.async_runtime.resolve(value(*args, **kwargs))
        if operation == "iter":
            iterator = value.__aiter__() if hasattr(value, "__aiter__") else iter(value)
            return iterator
        if operation == "next":
            try:
                if hasattr(value, "__anext__"):
                    item = self.async_runtime.resolve(value.__anext__())
                else:
                    item = next(value)
                return {"done": False, "value": item}
            except (StopIteration, StopAsyncIteration):
                return {"done": True, "value": None}
        if operation == "repr":
            return repr(value)
        if operation == "dir":
            return sorted(name for name in dir(value) if not name.startswith("_"))
        if operation == "value":
            return force_value(value)
        if operation == "release":
            self.registry.release(int(payload["target"]))
            return None
        raise ValueError(f"Unknown RPC operation: {operation}")

    def callback(self, callback_id: int) -> JavaScriptCallback:
        with self._callback_lock:
            callback = self._callbacks.get(callback_id)
            if callback is None:
                callback = JavaScriptCallback(self, callback_id)
                self._callbacks[callback_id] = callback
            return callback

    def invoke_callback(
        self,
        callback_id: int,
        args: list[Any],
        kwargs: dict[str, Any],
    ) -> Any:
        with self._callback_lock:
            request_id = self._next_callback_id
            self._next_callback_id += 1
            pending = PendingCallback()
            self._pending_callbacks[request_id] = pending
        self.connection.write(
            {
                "args": encode_wire(args, self),
                "callback": callback_id,
                "id": request_id,
                "kind": "callback",
                "kwargs": encode_wire(kwargs, self),
            }
        )
        pending.event.wait()
        message = pending.message or {}
        if message.get("ok") is True:
            return decode_wire(message.get("value"), self)
        error = message.get("error")
        detail = error.get("message") if isinstance(error, dict) else str(error)
        raise JavaScriptError(detail or "JavaScript callback failed")

    def _resolve_callback(self, message: dict[str, Any]) -> None:
        request_id = int(message.get("id", 0))
        with self._callback_lock:
            pending = self._pending_callbacks.pop(request_id, None)
        if pending is not None:
            pending.message = message
            pending.event.set()


def resolve_path(value: Any, path: list[str]) -> Any:
    for name in path:
        value = getattr(value, name)
    return value


def import_python_module(name: str) -> Any:
    candidate = Path(name)
    if candidate.suffix == ".py" or candidate.is_absolute() or any(
        separator in name for separator in ("/", "\\")
    ):
        source = candidate if candidate.is_absolute() else Path.cwd() / candidate
        source = source.resolve()
        module_name = f"pynect_file_{abs(hash(source))}"
        spec = importlib.util.spec_from_file_location(module_name, source)
        if spec is None or spec.loader is None:
            raise ImportError(f"Cannot import Python file: {source}")
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        spec.loader.exec_module(module)
        return module
    return importlib.import_module(name)


def encode_wire(value: Any, bridge: Bridge, seen: set[int] | None = None) -> Any:
    if value is None or isinstance(value, (bool, int, float, str, bytes)):
        return value
    if isinstance(value, (bytearray, memoryview)):
        return bytes(value)
    if isinstance(value, enum.Enum):
        return encode_wire(value.value, bridge, seen)
    if isinstance(value, dt.datetime):
        return {WIRE_TYPE: "datetime", "value": value.isoformat()}
    if isinstance(value, dt.date):
        return {WIRE_TYPE: "date", "value": value.isoformat()}
    if isinstance(value, dt.time):
        return {WIRE_TYPE: "time", "value": value.isoformat()}

    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        return encode_wire(model_dump(mode="json"), bridge, seen)
    legacy_dict = getattr(value, "dict", None)
    if callable(legacy_dict) and type(value).__module__.startswith("pydantic"):
        return encode_wire(legacy_dict(), bridge, seen)
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return encode_wire(dataclasses.asdict(value), bridge, seen)

    seen = seen or set()
    identity = id(value)
    if identity in seen:
        return python_reference(value, bridge)
    seen.add(identity)
    try:
        if isinstance(value, (list, tuple)):
            return [encode_wire(item, bridge, seen) for item in value]
        if isinstance(value, (set, frozenset)):
            return {
                WIRE_TYPE: "set",
                "value": [encode_wire(item, bridge, seen) for item in value],
            }
        if isinstance(value, Mapping):
            if all(isinstance(key, str) for key in value) and WIRE_TYPE not in value:
                return {
                    key: encode_wire(item, bridge, seen)
                    for key, item in value.items()
                }
            return {
                WIRE_TYPE: "map",
                "value": [
                    [encode_wire(key, bridge, seen), encode_wire(item, bridge, seen)]
                    for key, item in value.items()
                ],
            }
        return python_reference(value, bridge)
    finally:
        seen.remove(identity)


def python_reference(value: Any, bridge: Bridge) -> dict[str, Any]:
    return {
        WIRE_TYPE: "reference",
        "id": bridge.registry.add(value),
        "pythonType": f"{type(value).__module__}.{type(value).__qualname__}",
    }


def decode_wire(value: Any, bridge: Bridge) -> Any:
    if isinstance(value, list):
        return [decode_wire(item, bridge) for item in value]
    if not isinstance(value, dict):
        return value
    wire_type = value.get(WIRE_TYPE)
    if wire_type == "reference":
        return bridge.registry.get(int(value["id"]))
    if wire_type == "callback":
        return bridge.callback(int(value["id"]))
    if wire_type == "undefined":
        return None
    if wire_type == "datetime":
        return dt.datetime.fromisoformat(str(value["value"]).replace("Z", "+00:00"))
    if wire_type == "date":
        return dt.date.fromisoformat(str(value["value"]))
    if wire_type == "time":
        return dt.time.fromisoformat(str(value["value"]))
    if wire_type == "set":
        return {decode_wire(item, bridge) for item in value.get("value", [])}
    if wire_type == "map":
        return {
            decode_wire(entry[0], bridge): decode_wire(entry[1], bridge)
            for entry in value.get("value", [])
        }
    return {key: decode_wire(item, bridge) for key, item in value.items()}


def force_value(value: Any, seen: set[int] | None = None) -> Any:
    if value is None or isinstance(value, (bool, int, float, str, bytes)):
        return value
    if isinstance(value, (dt.datetime, dt.date, dt.time, enum.Enum)):
        return value
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        return model_dump(mode="json")
    legacy_dict = getattr(value, "dict", None)
    if callable(legacy_dict) and type(value).__module__.startswith("pydantic"):
        return legacy_dict()
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return dataclasses.asdict(value)

    seen = seen or set()
    identity = id(value)
    if identity in seen:
        raise ValueError("Cannot copy a circular Python value")
    seen.add(identity)
    try:
        if isinstance(value, (list, tuple, set, frozenset)):
            return [force_value(item, seen) for item in value]
        if isinstance(value, Mapping):
            return {key: force_value(item, seen) for key, item in value.items()}
        if hasattr(value, "__dict__"):
            return {
                key: force_value(item, seen)
                for key, item in vars(value).items()
                if not key.startswith("_")
            }
    finally:
        seen.remove(identity)
    raise TypeError(f"{type(value).__name__} cannot be copied by value")


def main() -> None:
    endpoint = os.environ.get("PYNECT_ENDPOINT")
    token = os.environ.get("PYNECT_TOKEN")
    if not endpoint or not token:
        raise RuntimeError("PYNECT_ENDPOINT and PYNECT_TOKEN are required")
    expected_parent = os.environ.get("PYNECT_PARENT_PID")
    if expected_parent and int(expected_parent) <= 0:
        raise RuntimeError("PYNECT_PARENT_PID is invalid")
    cwd = os.environ.get("PYNECT_CWD")
    if cwd:
        os.chdir(cwd)
        if cwd not in sys.path:
            sys.path.insert(0, cwd)
    connection = FramedConnection(endpoint)
    validate = os.environ.get("PYNECT_VALIDATE_PYDANTIC", "1") != "0"
    bridge = Bridge(connection, token, validate)
    bridge.run()


if __name__ == "__main__":
    main()
