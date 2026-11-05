"""ASGI fixture that fails after the stdio transport opens a connection."""

from typing import Any


async def app(_scope: dict[str, Any], receive: Any, _send: Any) -> None:
    message = await receive()
    if message != {"type": "websocket.connect"}:
        raise AssertionError(f"unexpected initial event: {message!r}")
    raise RuntimeError("fixture failed after open")
