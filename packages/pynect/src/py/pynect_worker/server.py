"""Direct multi-client WebSocket transport for Pynect."""

from __future__ import annotations

import concurrent.futures
import contextlib
import json
import os
import signal
import threading
from http import HTTPStatus
from types import FrameType
from typing import Any
from urllib.parse import urlsplit

from websockets.exceptions import ConnectionClosed
from websockets.http11 import Request, Response
from websockets.sync.server import Server, ServerConnection, serve

from .bridge import Bridge
from .connection import RpcConnection
from .framing import decode_frame, encode_frame
from .models import WEBSOCKET_SUBPROTOCOL, ServerOptions


class WebSocketConnection(RpcConnection):
    """Adapt one binary WebSocket session to the bridge connection contract."""

    def __init__(self, websocket: ServerConnection, max_frame_bytes: int) -> None:
        self._websocket = websocket
        self._max_frame_bytes = max_frame_bytes
        self._write_lock = threading.Lock()
        self._closed = False

    def read(self) -> dict[str, Any] | None:
        try:
            frame = self._websocket.recv()
        except ConnectionClosed:
            return None
        if isinstance(frame, str):
            self._websocket.close(1003, "Binary Pynect frames required")
            raise TypeError("Pynect WebSocket messages must be binary")
        return decode_frame(bytes(frame), self._max_frame_bytes)

    def write(self, message: dict[str, Any]) -> None:
        frame = encode_frame(message, self._max_frame_bytes)
        with self._write_lock:
            if self._closed:
                raise EOFError("WebSocket connection is closed")
            self._websocket.send(frame)

    def close(self) -> None:
        with self._write_lock:
            if self._closed:
                return
            self._closed = True
            with contextlib.suppress(ConnectionClosed):
                self._websocket.close()


class PynectServer:
    """A shared Python process with an isolated bridge per WebSocket client."""

    def __init__(self, options: ServerOptions) -> None:
        self.options = options
        self._sessions: set[WebSocketConnection] = set()
        self._sessions_lock = threading.Lock()
        worker_count = min(32, (os.cpu_count() or 1) + 4)
        self._executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=worker_count,
            thread_name_prefix="pynect-server-call",
        )
        self._server: Server = serve(
            self._handle,
            options.host,
            options.port,
            compression=None,
            max_size=options.max_frame_bytes + 4,
            process_request=self._process_request,
            subprotocols=[WEBSOCKET_SUBPROTOCOL],
        )
        self._shutdown_started = threading.Event()

    @property
    def url(self) -> str:
        """Return the actual bound URL, including an operating-system-selected port."""

        address = self._server.socket.getsockname()
        host = self.options.host
        if host in {"0.0.0.0", "::"}:
            host = str(address[0])
        if ":" in host and not host.startswith("["):
            host = f"[{host}]"
        return f"ws://{host}:{address[1]}{self.options.path}"

    @property
    def active_connections(self) -> int:
        """Return the number of bridge sessions currently connected."""

        with self._sessions_lock:
            return len(self._sessions)

    def serve_forever(self) -> None:
        """Accept clients until shutdown is requested."""

        self._server.serve_forever()

    def shutdown(self) -> None:
        """Stop accepting clients and close active sessions without signaling them."""

        if self._shutdown_started.is_set():
            return
        self._shutdown_started.set()
        with self._sessions_lock:
            sessions = tuple(self._sessions)
        for session in sessions:
            session.close()
        self._server.shutdown()

    def close(self) -> None:
        """Release server and shared executor resources."""

        self.shutdown()
        self._executor.shutdown(wait=False, cancel_futures=True)

    def _handle(self, websocket: ServerConnection) -> None:
        connection = WebSocketConnection(websocket, self.options.max_frame_bytes)
        with self._sessions_lock:
            self._sessions.add(connection)
        try:
            Bridge(
                connection,
                token=None,
                validate_pydantic=self.options.validate_pydantic,
                modules=self.options.modules,
                executor=self._executor,
            ).run()
        finally:
            with self._sessions_lock:
                self._sessions.discard(connection)

    def _process_request(
        self,
        connection: ServerConnection,
        request: Request,
    ) -> Response | None:
        if urlsplit(request.path).path != self.options.path:
            return connection.respond(HTTPStatus.NOT_FOUND, "Not found\n")
        offered = {
            item.strip() for item in request.headers.get("Sec-WebSocket-Protocol", "").split(",") if item.strip()
        }
        if WEBSOCKET_SUBPROTOCOL not in offered:
            return connection.respond(
                HTTPStatus.UPGRADE_REQUIRED,
                f"WebSocket subprotocol {WEBSOCKET_SUBPROTOCOL} is required\n",
            )
        return None


class ShutdownLatch:
    """Latch the first process termination request and replay it after server startup."""

    def __init__(self) -> None:
        self.requested = threading.Event()
        self._server: PynectServer | None = None
        self._lock = threading.Lock()

    def attach(self, server: PynectServer) -> None:
        """Attach a constructed server and replay any earlier request."""

        with self._lock:
            self._server = server
            requested = self.requested.is_set()
        if requested:
            self._shutdown(server)

    def handle(self, _signal: int, _frame: FrameType | None) -> None:
        """Record one signal and ask the server to stop from a safe helper thread."""

        self.requested.set()
        with self._lock:
            server = self._server
        if server is not None:
            self._shutdown(server)

    @staticmethod
    def _shutdown(server: PynectServer) -> None:
        threading.Thread(
            target=server.shutdown,
            name="pynect-server-shutdown",
            daemon=True,
        ).start()


def run_server(options: ServerOptions) -> None:
    """Run a server with single-delivery SIGINT and SIGTERM handling."""

    latch = ShutdownLatch()
    handled_signals = tuple(
        candidate
        for candidate in (getattr(signal, "SIGINT", None), getattr(signal, "SIGTERM", None))
        if candidate is not None
    )
    previous = {candidate: signal.getsignal(candidate) for candidate in handled_signals}
    for candidate in handled_signals:
        signal.signal(candidate, latch.handle)

    server: PynectServer | None = None
    try:
        server = PynectServer(options)
        latch.attach(server)
        print(
            json.dumps({"event": "listening", "pid": os.getpid(), "url": server.url}),
            flush=True,
        )
        server.serve_forever()
    finally:
        if server is not None:
            server.close()
        for candidate, handler in previous.items():
            signal.signal(candidate, handler)
