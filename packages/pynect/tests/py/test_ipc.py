import asyncio
import json
from typing import Any

from pynect_worker.ipc import handle_connection


def test_handle_connection_translates_lines_to_asgi_websocket() -> None:
    async def exercise() -> None:
        scopes: list[dict[str, Any]] = []

        async def app(scope: dict[str, Any], receive: Any, send: Any) -> None:
            scopes.append(scope)
            assert await receive() == {"type": "websocket.connect"}
            message = await receive()
            await send({"type": "websocket.send", "text": message["text"]})
            await send({"type": "websocket.close", "code": 1000})

        server = await asyncio.start_server(
            lambda reader, writer: handle_connection(app, reader, writer),
            host="127.0.0.1",
            port=0,
        )
        address = server.sockets[0].getsockname()
        reader, writer = await asyncio.open_connection(address[0], address[1])
        handshake = {
            "path": "/ws/catalog",
            "query": "scope=all",
            "headers": {"authorization": "Bearer test"},
            "subprotocols": ["chanx.v1"],
        }
        writer.write(json.dumps(handshake).encode() + b"\n")
        writer.write(b'{"action":"ping","payload":{"value":"hi"}}\n')
        await writer.drain()

        assert await reader.readline() == b'{"action":"ping","payload":{"value":"hi"}}\n'
        assert scopes[0]["path"] == "/ws/catalog"
        assert scopes[0]["query_string"] == b"scope=all"
        assert scopes[0]["headers"] == [(b"authorization", b"Bearer test")]

        writer.close()
        await writer.wait_closed()
        server.close()
        await server.wait_closed()

    asyncio.run(exercise())
