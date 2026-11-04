from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import dataclasses
import datetime as dt
import enum
import importlib
import importlib.util
import inspect
import os
import sys
import threading
import traceback
import weakref
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any, get_type_hints

from .connection import FramedConnection, RpcConnection
from .models import PROTOCOL_VERSION, MessageKind, Operation, WireValueType

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
        self._lock = threading.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._closed = False

    def _run(self) -> None:
        loop = self._loop
        if loop is None:
            return
        asyncio.set_event_loop(loop)
        loop.run_forever()

    def _ensure_started(self) -> asyncio.AbstractEventLoop:
        with self._lock:
            if self._closed:
                raise RuntimeError("The Pynect asyncio runtime is closed")
            if self._loop is not None:
                return self._loop
            loop = asyncio.new_event_loop()
            self._loop = loop
            thread = threading.Thread(
                target=self._run,
                name="pynect-asyncio",
                daemon=True,
            )
            self._thread = thread
            thread.start()
            return loop

    def resolve(self, value: Any) -> Any:
        if not inspect.isawaitable(value):
            return value

        async def await_value() -> Any:
            return await value

        return asyncio.run_coroutine_threadsafe(
            await_value(),
            self._ensure_started(),
        ).result()

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            loop = self._loop
            thread = self._thread
            self._loop = None
            self._thread = None
        if loop is None:
            return
        with contextlib.suppress(Exception):
            asyncio.run_coroutine_threadsafe(self._cancel_pending(), loop).result(timeout=2)
        loop.call_soon_threadsafe(loop.stop)
        if thread is not None:
            thread.join(timeout=2)
        if not loop.is_closed():
            loop.close()

    @staticmethod
    async def _cancel_pending() -> None:
        current = asyncio.current_task()
        tasks = [task for task in asyncio.all_tasks() if task is not current]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        await asyncio.get_running_loop().shutdown_asyncgens()


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
                bound.arguments[name] = tuple(self._validate(annotation, item) for item in value)
            elif parameter.kind is inspect.Parameter.VAR_KEYWORD:
                bound.arguments[name] = {key: self._validate(annotation, item) for key, item in value.items()}
            else:
                bound.arguments[name] = self._validate(annotation, value)
        return list(bound.args), dict(bound.kwargs)

    def _validate(self, annotation: Any, value: Any) -> Any:
        type_adapter = getattr(self._pydantic, "TypeAdapter", None)
        if type_adapter is not None:
            return type_adapter(annotation).validate_python(value)
        parse_obj_as = getattr(self._pydantic, "parse_obj_as", None)
        return parse_obj_as(annotation, value) if parse_obj_as else value


@dataclasses.dataclass
class PendingCallback:
    event: threading.Event = dataclasses.field(default_factory=threading.Event)
    message: dict[str, Any] | None = None


class JavaScriptCallback:
    def __init__(self, bridge: Bridge, callback_id: int) -> None:
        self._bridge = bridge
        self._callback_id = callback_id
        self._release = weakref.finalize(
            self,
            bridge.release_callback,
            callback_id,
        )

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        return self._bridge.invoke_callback(self._callback_id, list(args), kwargs)


class Bridge:
    def __init__(
        self,
        connection: RpcConnection,
        token: str | None,
        validate_pydantic: bool,
        modules: Mapping[str, str] | None = None,
        executor: concurrent.futures.Executor | None = None,
    ) -> None:
        self.connection = connection
        self.token = token
        self.modules = None if modules is None else dict(modules)
        self.registry = ObjectRegistry()
        self.async_runtime = AsyncRuntime()
        self.validator = PydanticValidator(validate_pydantic)
        self._stopped = threading.Event()
        self._callback_lock = threading.Lock()
        self._next_callback_id = 1
        self._pending_callbacks: dict[int, PendingCallback] = {}
        self._owns_executor = executor is None
        worker_count = min(8, (os.cpu_count() or 1) + 4)
        self._executor = executor or concurrent.futures.ThreadPoolExecutor(
            max_workers=worker_count, thread_name_prefix="pynect-call"
        )

    def run(self) -> None:
        hello: dict[str, Any] = {
            "kind": MessageKind.HELLO.value,
            "pid": os.getpid(),
            "protocol": PROTOCOL_VERSION,
        }
        if self.token is not None:
            hello["token"] = self.token
        self.connection.write(hello)
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
            if self._owns_executor:
                self._executor.shutdown(wait=False, cancel_futures=True)
            self.async_runtime.close()
            self.registry.clear()
            self.connection.close()

    def _dispatch_message(self, message: dict[str, Any]) -> None:
        kind = parse_message_kind(message.get("kind"))
        if kind is MessageKind.CALLBACK_RESULT:
            self._resolve_callback(message)
            return
        if kind not in {MessageKind.REQUEST, MessageKind.NOTIFY}:
            raise TypeError(f"Unknown RPC message kind: {kind}")
        operation = parse_operation(message.get("op"))
        if operation is Operation.SHUTDOWN and kind is MessageKind.REQUEST:
            self.connection.write(
                {
                    "id": message.get("id"),
                    "kind": MessageKind.RESPONSE.value,
                    "ok": True,
                    "value": None,
                }
            )
            self._stopped.set()
            return
        self._executor.submit(self._handle_request, message)

    def _handle_request(self, message: dict[str, Any]) -> None:
        request_id = message.get("id")
        expects_response = parse_message_kind(message.get("kind")) is MessageKind.REQUEST
        try:
            payload = decode_wire(message.get("payload", {}), self)
            if not isinstance(payload, dict):
                raise TypeError("RPC request payload must be a map")
            result = self._operate(parse_operation(message.get("op")), payload)
            if expects_response:
                self.connection.write(
                    {
                        "id": request_id,
                        "kind": MessageKind.RESPONSE.value,
                        "ok": True,
                        "value": encode_wire(result, self),
                    }
                )
        # Even SystemExit from user code must become a response instead of stranding the host.
        except BaseException as error:  # noqa: BLE001
            if expects_response:
                self.connection.write(
                    {
                        "error": {
                            "message": str(error),
                            "traceback": traceback.format_exc(),
                            "type": type(error).__name__,
                        },
                        "id": request_id,
                        "kind": MessageKind.RESPONSE.value,
                        "ok": False,
                    }
                )

    def _operate(self, operation: Operation, payload: dict[str, Any]) -> Any:
        if operation is Operation.IMPORT:
            public_name = str(payload["name"])
            if self.modules is None:
                module_name = public_name
            else:
                try:
                    module_name = self.modules[public_name]
                except KeyError as error:
                    raise PermissionError(
                        f'Python module "{public_name}" is not exposed by this Pynect server.'
                    ) from error
            return import_python_module(module_name)
        target = self.registry.get(int(payload["target"]))
        path = [str(part) for part in payload.get("path", [])]
        value = resolve_path(target, path)
        if operation is Operation.GET:
            return value
        if operation is Operation.SET:
            if not path:
                raise TypeError("Setting a root Python reference is not supported")
            parent = resolve_path(target, path[:-1])
            setattr(parent, path[-1], payload.get("value"))
            return None
        if operation is Operation.CALL:
            if not callable(value):
                raise TypeError(f"{type(value).__name__} object is not callable")
            args = list(payload.get("args", []))
            kwargs = dict(payload.get("kwargs", {}))
            args, kwargs = self.validator.arguments(value, args, kwargs)
            return self.async_runtime.resolve(value(*args, **kwargs))
        if operation is Operation.ITER:
            iterator = value.__aiter__() if hasattr(value, "__aiter__") else iter(value)
            return iterator
        if operation is Operation.NEXT:
            try:
                item = self.async_runtime.resolve(value.__anext__()) if hasattr(value, "__anext__") else next(value)
                return {"done": False, "value": item}
            except (StopIteration, StopAsyncIteration):
                return {"done": True, "value": None}
        if operation is Operation.REPR:
            return repr(value)
        if operation is Operation.DIR:
            return sorted(name for name in dir(value) if not name.startswith("_"))
        if operation is Operation.VALUE:
            return force_value(value)
        if operation is Operation.RELEASE:
            self.registry.release(int(payload["target"]))
            return None
        raise ValueError(f"Unknown RPC operation: {operation}")

    def callback(self, callback_id: int) -> JavaScriptCallback:
        return JavaScriptCallback(self, callback_id)

    def release_callback(self, callback_id: int) -> None:
        if self._stopped.is_set():
            return
        with contextlib.suppress(EOFError, OSError):
            self.connection.write(
                {
                    "callback": callback_id,
                    "kind": MessageKind.CALLBACK_RELEASE.value,
                }
            )

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
                "kind": MessageKind.CALLBACK.value,
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


def parse_message_kind(value: Any) -> MessageKind:
    try:
        return MessageKind(value)
    except (TypeError, ValueError) as error:
        raise TypeError(f"Unknown RPC message kind: {value}") from error


def parse_operation(value: Any) -> Operation:
    try:
        return Operation(value)
    except (TypeError, ValueError) as error:
        raise TypeError(f"Unknown RPC operation: {value}") from error


def import_python_module(name: str) -> Any:
    candidate = Path(name)
    if candidate.suffix == ".py" or candidate.is_absolute() or any(separator in name for separator in ("/", "\\")):
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
        return {WIRE_TYPE: WireValueType.DATETIME.value, "value": value.isoformat()}
    if isinstance(value, dt.date):
        return {WIRE_TYPE: WireValueType.DATE.value, "value": value.isoformat()}
    if isinstance(value, dt.time):
        return {WIRE_TYPE: WireValueType.TIME.value, "value": value.isoformat()}

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
                WIRE_TYPE: WireValueType.SET.value,
                "value": [encode_wire(item, bridge, seen) for item in value],
            }
        if isinstance(value, Mapping):
            if all(isinstance(key, str) for key in value) and WIRE_TYPE not in value:
                return {key: encode_wire(item, bridge, seen) for key, item in value.items()}
            return {
                WIRE_TYPE: WireValueType.MAP.value,
                "value": [
                    [encode_wire(key, bridge, seen), encode_wire(item, bridge, seen)] for key, item in value.items()
                ],
            }
        return python_reference(value, bridge)
    finally:
        seen.remove(identity)


def python_reference(value: Any, bridge: Bridge) -> dict[str, Any]:
    return {
        WIRE_TYPE: WireValueType.REFERENCE.value,
        "id": bridge.registry.add(value),
        "pythonType": f"{type(value).__module__}.{type(value).__qualname__}",
    }


def decode_wire(value: Any, bridge: Bridge) -> Any:
    if isinstance(value, list):
        return [decode_wire(item, bridge) for item in value]
    if not isinstance(value, dict):
        return value
    if WIRE_TYPE not in value:
        return {key: decode_wire(item, bridge) for key, item in value.items()}
    try:
        wire_type = WireValueType(value[WIRE_TYPE])
    except (TypeError, ValueError) as error:
        raise TypeError(f"Unknown wire value type: {value[WIRE_TYPE]}") from error
    if wire_type is WireValueType.REFERENCE:
        return bridge.registry.get(int(value["id"]))
    if wire_type is WireValueType.CALLBACK:
        return bridge.callback(int(value["id"]))
    if wire_type is WireValueType.UNDEFINED:
        return None
    if wire_type is WireValueType.DATETIME:
        # Python 3.10 needs the UTC designator normalized before fromisoformat.
        return dt.datetime.fromisoformat(str(value["value"]).replace("Z", "+00:00"))
    if wire_type is WireValueType.DATE:
        return dt.date.fromisoformat(str(value["value"]))
    if wire_type is WireValueType.TIME:
        return dt.time.fromisoformat(str(value["value"]))
    if wire_type is WireValueType.SET:
        return {decode_wire(item, bridge) for item in value.get("value", [])}
    if wire_type is WireValueType.MAP:
        return {decode_wire(entry[0], bridge): decode_wire(entry[1], bridge) for entry in value.get("value", [])}
    raise AssertionError(f"Unhandled wire value type: {wire_type}")


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
            return {key: force_value(item, seen) for key, item in vars(value).items() if not key.startswith("_")}
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
