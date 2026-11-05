"""Run one application connection over an owning process's stdin and stdout."""

import asyncio
import logging
import os
import sys
import threading
from contextlib import suppress
from dataclasses import dataclass
from typing import Any, BinaryIO

import structlog

from pynect._app import load_object
from pynect.worker.protocol import (
    ParentEvent,
    ProtocolError,
    ProtocolWriter,
    prefix_from_environment,
    read_parent_event,
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class _ApplicationFinished:
    connection: "StdioConnection"


class _EndOfInput:
    pass


@dataclass(frozen=True)
class _InputFailure:
    error: Exception


END_OF_INPUT = _EndOfInput()
InputItem = ParentEvent | _ApplicationFinished | _EndOfInput | _InputFailure


class StdinPump:
    """Read blocking stdin on a daemon thread so the event loop can stop promptly."""

    def __init__(self, input_stream: BinaryIO, prefix: bytes, queue: asyncio.Queue[InputItem]) -> None:
        self._input = input_stream
        self._prefix = prefix
        self._queue = queue
        self._loop = asyncio.get_running_loop()
        self._thread = threading.Thread(target=self._read, name="pynect-stdio-reader", daemon=True)

    def start(self) -> None:
        """Start reading records in source order."""
        self._thread.start()

    def join(self) -> None:
        """Wait for the reader after a terminal input event."""
        self._thread.join()

    def _read(self) -> None:
        try:
            while (event := read_parent_event(self._input, self._prefix)) is not None:
                self._enqueue(event)
                if event["type"] == "shutdown":
                    return
        except Exception as error:
            self._enqueue(_InputFailure(error))
        finally:
            self._enqueue(END_OF_INPUT)

    def _enqueue(self, item: ParentEvent | _EndOfInput | _InputFailure) -> None:
        with suppress(RuntimeError):
            self._loop.call_soon_threadsafe(self._queue.put_nowait, item)


class StdioConnection:
    """Adapt one virtual WebSocket to an ASGI application invocation."""

    def __init__(
        self,
        app: Any,
        event: dict[str, Any],
        writer: ProtocolWriter,
        queue: asyncio.Queue[InputItem],
    ) -> None:
        self._incoming: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._incoming.put_nowait({"type": "websocket.connect"})
        self._writer = writer
        self._disconnected = False
        self.close_sent = False
        path = event["path"]
        headers = [
            (name.lower().encode("latin-1"), value.encode("latin-1")) for name, value in event["headers"].items()
        ]
        scope = {
            "type": "websocket",
            "asgi": {"version": "3.0", "spec_version": "2.4"},
            "http_version": "1.1",
            "scheme": "ws",
            "path": path,
            "raw_path": path.encode(),
            "query_string": event["query"].encode(),
            "headers": headers,
            "client": None,
            "server": None,
            "subprotocols": event["subprotocols"],
            "state": {},
        }
        self.task = asyncio.create_task(app(scope, self.receive, self.send), name="pynect-stdio-application")
        self.task.add_done_callback(lambda _: queue.put_nowait(_ApplicationFinished(self)))

    async def receive(self) -> dict[str, Any]:
        """Return the next virtual WebSocket input event."""
        return await self._incoming.get()

    async def send(self, message: dict[str, Any]) -> None:
        """Translate ASGI output into one serialized worker event."""
        message_type = message.get("type")
        if message_type == "websocket.accept":
            return
        if message_type == "websocket.send":
            data = message.get("text")
            if data is None:
                binary = message.get("bytes", b"")
                if not isinstance(binary, bytes):
                    raise TypeError("websocket.send bytes must be bytes")
                data = binary.decode()
            if not isinstance(data, str):
                raise TypeError("websocket.send text must be a string")
            self._writer.write({"type": "frame", "data": data})
            return
        if message_type == "websocket.close":
            code = message.get("code", 1000)
            reason = message.get("reason", "")
            if type(code) is not int or not isinstance(reason, str):
                raise TypeError("websocket.close requires an integer code and string reason")
            if not self.close_sent:
                self.close_sent = True
                self._writer.write({"type": "close", "code": code, "reason": reason})
            return
        raise RuntimeError(f"unsupported ASGI WebSocket event: {message_type!r}")

    def frame(self, data: str) -> None:
        """Deliver one opaque Chanx text frame to the application."""
        if self._disconnected:
            raise ProtocolError("received a frame after the virtual connection closed")
        self._incoming.put_nowait({"type": "websocket.receive", "text": data})

    def disconnect(self, code: int) -> None:
        """Deliver at most one ASGI disconnect event."""
        if self._disconnected:
            return
        self._disconnected = True
        self._incoming.put_nowait({"type": "websocket.disconnect", "code": code})

    async def stop(self, code: int) -> None:
        """Let the app observe disconnect, then cancel a task that does not stop."""
        self.disconnect(code)
        if not self.task.done():
            try:
                await asyncio.wait_for(asyncio.shield(self.task), timeout=0.25)
            except TimeoutError:
                self.task.cancel()
        with suppress(asyncio.CancelledError):
            await self.task


async def _serve(
    app: Any,
    prefix: bytes,
    input_stream: BinaryIO | None = None,
    output_stream: BinaryIO | None = None,
) -> None:
    """Serve a loaded application until shutdown or stdin EOF."""
    writer = ProtocolWriter(prefix, output_stream)
    queue: asyncio.Queue[InputItem] = asyncio.Queue()
    pump = StdinPump(input_stream or sys.stdin.buffer, prefix, queue)
    connection: StdioConnection | None = None
    try:
        pump.start()
        while True:
            item = await queue.get()
            if item is END_OF_INPUT:
                pump.join()
                if connection is not None:
                    await connection.stop(1001)
                    if not connection.close_sent:
                        writer.write({"type": "close", "code": 1001, "reason": "stdin closed"})
                writer.write({"type": "bye"})
                return
            if isinstance(item, _InputFailure):
                raise item.error
            if isinstance(item, _ApplicationFinished):
                if item.connection is not connection:
                    continue
                if item.connection.task.cancelled():
                    raise RuntimeError("ASGI application was cancelled")
                exception = item.connection.task.exception()
                if exception is not None:
                    raise RuntimeError("ASGI application failed") from exception
                if not item.connection.close_sent:
                    writer.write({"type": "close", "code": 1000, "reason": ""})
                connection = None
                continue

            event = item
            event_type = event["type"]
            if event_type == "open":
                if connection is not None:
                    raise ProtocolError("only one virtual connection may be open")
                connection = StdioConnection(app, event, writer, queue)
            elif event_type == "frame":
                if connection is None:
                    raise ProtocolError("received a frame before open")
                connection.frame(event["data"])
            elif event_type == "close":
                if connection is not None:
                    current = connection
                    connection = None
                    await current.stop(event["code"])
                    if not current.close_sent:
                        writer.write({"type": "close", "code": event["code"], "reason": event["reason"]})
            elif event_type == "shutdown":
                pump.join()
                if connection is not None:
                    await connection.stop(1001)
                    if not connection.close_sent:
                        writer.write({"type": "close", "code": 1001, "reason": "worker shutdown"})
                writer.write({"type": "bye"})
                return
    except Exception as error:
        with suppress(Exception):
            writer.write({"type": "error", "message": str(error)})
        raise


async def serve(
    app_target: str,
    prefix: bytes,
    input_stream: BinaryIO | None = None,
    output_stream: BinaryIO | None = None,
) -> None:
    """Load an application and serve it over stdio."""
    await _serve(load_object(app_target), prefix, input_stream, output_stream)


def main() -> None:
    """Console entry point driven by the JavaScript stdio launcher."""
    level_name = os.environ.get("PYNECT_LOG_LEVEL", "WARNING").upper()
    level = logging.getLevelNamesMapping().get(level_name)
    if level is None:
        raise ValueError(f"Unknown PYNECT_LOG_LEVEL: {level_name}")
    logging.basicConfig(
        level=level,
        format="%(message)s",
    )
    structlog.configure(wrapper_class=structlog.make_filtering_bound_logger(level))
    app_target = os.environ.get("PYNECT_APP")
    if not app_target:
        raise RuntimeError("PYNECT_APP is required")
    prefix = prefix_from_environment()
    app = load_object(app_target)
    ProtocolWriter(prefix).write({"type": "ready"})
    with suppress(KeyboardInterrupt):
        asyncio.run(_serve(app, prefix))
