from __future__ import annotations

import asyncio
import signal
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager

from websockets.sync.client import connect

from pynect_worker.bridge import AsyncRuntime
from pynect_worker.framing import decode_frame, encode_frame
from pynect_worker.models import (
    DEFAULT_WEBSOCKET_FRAME_BYTES,
    PROTOCOL_VERSION,
    WEBSOCKET_SUBPROTOCOL,
    MessageKind,
    ServerOptions,
)
from pynect_worker.server import PynectServer, ShutdownLatch


@contextmanager
def running_server(**options: object) -> Iterator[PynectServer]:
    server = PynectServer(ServerOptions.model_validate(options))
    thread = threading.Thread(target=server.serve_forever)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.close()
        assert not thread.is_alive()


def test_websocket_sessions_are_removed_without_per_client_async_threads() -> None:
    before = pynect_async_threads()
    with running_server() as server:
        for _ in range(12):
            with connect(server.url, subprotocols=[WEBSOCKET_SUBPROTOCOL]) as socket:
                hello = decode_frame(
                    bytes(socket.recv()),
                    DEFAULT_WEBSOCKET_FRAME_BYTES,
                )
                assert hello["kind"] == MessageKind.HELLO
                assert hello["protocol"] == PROTOCOL_VERSION
                assert "token" not in hello
        wait_for(lambda: server.active_connections == 0)
        assert server.active_connections == 0
        assert pynect_async_threads() == before


def test_async_runtime_is_lazy_and_releases_its_thread() -> None:
    before = pynect_async_threads()
    runtime = AsyncRuntime()
    assert pynect_async_threads() == before

    async def value() -> int:
        await asyncio.sleep(0)
        return 7

    assert runtime.resolve(value()) == 7
    assert len(pynect_async_threads()) == len(before) + 1
    runtime.close()
    wait_for(lambda: pynect_async_threads() == before)
    assert pynect_async_threads() == before


def test_server_denies_imports_until_a_module_is_exposed() -> None:
    with running_server() as server, connect(server.url, subprotocols=[WEBSOCKET_SUBPROTOCOL]) as socket:
        socket.recv()
        socket.send(
            encode_frame(
                {
                    "id": 1,
                    "kind": MessageKind.REQUEST.value,
                    "op": "import",
                    "payload": {"name": "os"},
                },
                DEFAULT_WEBSOCKET_FRAME_BYTES,
            )
        )
        response = decode_frame(
            bytes(socket.recv()),
            DEFAULT_WEBSOCKET_FRAME_BYTES,
        )

    assert response["ok"] is False
    assert response["error"]["type"] == "PermissionError"


def test_shutdown_requested_before_listener_loop_is_replayed() -> None:
    latch = ShutdownLatch()
    latch.handle(signal.SIGTERM, None)
    server = PynectServer(ServerOptions())
    latch.attach(server)
    thread = threading.Thread(target=server.serve_forever)
    thread.start()
    thread.join(timeout=2)
    server.close()

    assert not thread.is_alive()


def pynect_async_threads() -> set[int | None]:
    return {thread.ident for thread in threading.enumerate() if thread.name == "pynect-asyncio"}


def wait_for(predicate: Callable[[], bool]) -> None:
    deadline = time.monotonic() + 2
    while not predicate() and time.monotonic() < deadline:
        time.sleep(0.01)
