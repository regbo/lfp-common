"""Expose any Chanx ASGI app over newline-delimited local IPC."""

import asyncio
import ctypes
import json
import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Any

from pynect_worker._app import load_object

logger = logging.getLogger(__name__)

PARENT_POLL_INTERVAL_SECONDS = 0.5
WINDOWS_SYNCHRONIZE = 0x00100000
WINDOWS_WAIT_TIMEOUT = 0x00000102


async def handle_connection(
    app: Any,
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
) -> None:
    """Translate one local stream into an ASGI WebSocket connection."""
    handshake_line = await reader.readline()
    if not handshake_line:
        writer.close()
        return

    handshake = json.loads(handshake_line)
    path = handshake.get("path")
    if not isinstance(path, str) or not path.startswith("/"):
        raise ValueError("IPC handshake requires an absolute WebSocket path")
    raw_headers = handshake.get("headers", {})
    if not isinstance(raw_headers, dict):
        raise ValueError("IPC handshake headers must be an object")
    headers = [
        (str(name).lower().encode("latin-1"), str(value).encode("latin-1")) for name, value in raw_headers.items()
    ]
    incoming: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    incoming.put_nowait({"type": "websocket.connect"})

    async def read_messages() -> None:
        try:
            async for line in reader:
                incoming.put_nowait(
                    {
                        "type": "websocket.receive",
                        "text": line.decode().removesuffix("\n").removesuffix("\r"),
                    }
                )
        finally:
            incoming.put_nowait({"type": "websocket.disconnect", "code": 1000})

    async def receive() -> dict[str, Any]:
        return await incoming.get()

    async def send(message: dict[str, Any]) -> None:
        if message["type"] == "websocket.send":
            data = message.get("text")
            if data is None:
                data = message.get("bytes", b"").decode()
            writer.write(data.encode() + b"\n")
            await writer.drain()
        elif message["type"] == "websocket.close":
            writer.close()

    reader_task = asyncio.create_task(read_messages())
    try:
        await app(
            {
                "type": "websocket",
                "asgi": {"version": "3.0", "spec_version": "2.4"},
                "http_version": "1.1",
                "scheme": "ws",
                "path": path,
                "raw_path": path.encode(),
                "query_string": str(handshake.get("query", "")).encode(),
                "headers": headers,
                "client": None,
                "server": None,
                "subprotocols": handshake.get("subprotocols", []),
                "state": {},
            },
            receive,
            send,
        )
    finally:
        reader_task.cancel()
        with suppress(asyncio.CancelledError):
            await reader_task
        writer.close()
        with suppress(ConnectionError):
            await writer.wait_closed()


async def remove_stale_socket(path: Path) -> None:
    """Remove an abandoned Unix socket without disturbing a live server."""
    if not path.exists():
        return
    if not path.is_socket():
        raise RuntimeError(f"IPC path exists and is not a socket: {path}")
    try:
        _, writer = await asyncio.open_unix_connection(path)
    except (ConnectionRefusedError, FileNotFoundError):
        path.unlink(missing_ok=True)
        return
    writer.close()
    await writer.wait_closed()
    raise RuntimeError(f"IPC server is already running at {path}")


@asynccontextmanager
async def ipc_server(app: Any, ipc_path: str) -> AsyncIterator[str]:
    """Serve an ASGI app on a Unix socket or Windows named pipe."""
    if os.name == "nt":
        loop = asyncio.get_running_loop()
        servers = await loop.start_serving_pipe(  # type: ignore[attr-defined]
            lambda: asyncio.StreamReaderProtocol(
                asyncio.StreamReader(),
                client_connected_cb=lambda reader, writer: handle_connection(app, reader, writer),
            ),
            ipc_path,
        )
        try:
            yield ipc_path
        finally:
            for server in servers:
                server.close()
    else:
        socket_path = Path(ipc_path)
        await remove_stale_socket(socket_path)
        server = await asyncio.start_unix_server(
            lambda reader, writer: handle_connection(app, reader, writer),
            path=socket_path,
        )
        socket_path.chmod(0o600)
        try:
            yield ipc_path
        finally:
            server.close()
            await server.wait_closed()
            socket_path.unlink(missing_ok=True)


def process_is_alive(pid: int) -> bool:
    """Return whether a process is still addressable by this user."""
    if os.name == "nt":
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        open_process = kernel32.OpenProcess
        open_process.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
        open_process.restype = ctypes.c_void_p
        wait_for_single_object = kernel32.WaitForSingleObject
        wait_for_single_object.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        wait_for_single_object.restype = ctypes.c_ulong
        close_handle = kernel32.CloseHandle
        close_handle.argtypes = [ctypes.c_void_p]
        close_handle.restype = ctypes.c_int

        handle = open_process(WINDOWS_SYNCHRONIZE, False, pid)
        if not handle:
            return False
        try:
            return wait_for_single_object(handle, 0) == WINDOWS_WAIT_TIMEOUT
        finally:
            close_handle(handle)
    else:
        try:
            os.kill(pid, 0)
        except OSError:
            return False
        return True


async def wait_for_process_exit(pid: int) -> None:
    """Wait until the owning JavaScript process exits."""
    while process_is_alive(pid):
        await asyncio.sleep(PARENT_POLL_INTERVAL_SECONDS)


async def serve(app_target: str, ipc_path: str, parent_pid: int | None = None) -> None:
    """Import the configured app and serve until the process is interrupted."""
    app = load_object(app_target)
    async with ipc_server(app, ipc_path) as path:
        logger.debug("IPC server listening at %s", path)
        if parent_pid is None:
            await asyncio.Event().wait()
        else:
            await wait_for_process_exit(parent_pid)


def main() -> None:
    """Console entry point driven by the Node launcher environment."""
    logging.basicConfig(
        level=os.environ.get("PYNECT_LOG_LEVEL", "INFO"),
        format="%(message)s",
    )
    app_target = os.environ.get("PYNECT_APP")
    ipc_path = os.environ.get("PYNECT_IPC_PATH")
    parent_pid_value = os.environ.get("PYNECT_PARENT_PID")
    if not app_target:
        raise RuntimeError("PYNECT_APP is required")
    if not ipc_path:
        raise RuntimeError("PYNECT_IPC_PATH is required")
    parent_pid = int(parent_pid_value) if parent_pid_value else None
    if parent_pid is not None and parent_pid <= 0:
        raise RuntimeError("PYNECT_PARENT_PID must be a positive integer")
    with suppress(KeyboardInterrupt):
        asyncio.run(serve(app_target, ipc_path, parent_pid))
