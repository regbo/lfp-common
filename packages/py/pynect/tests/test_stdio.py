import asyncio
import json
import threading
from io import BytesIO
from typing import Any

import pytest

from pynect.worker.protocol import (
    MAX_RECORD_BYTES,
    ProtocolError,
    ProtocolWriter,
    encode_record,
    parse_parent_record,
)

PREFIX = b"@pynect:test-token "


def test_protocol_validates_parent_events_and_serializes_atomically() -> None:
    event = {
        "type": "open",
        "path": "/ws/catalog",
        "query": "scope=all",
        "headers": {"authorization": "Bearer test"},
        "subprotocols": ["chanx.v1"],
    }
    assert parse_parent_record(encode_record(PREFIX, event), PREFIX) == event

    with pytest.raises(ProtocolError, match="unknown"):
        parse_parent_record(encode_record(PREFIX, {"type": "mystery"}), PREFIX)
    with pytest.raises(ProtocolError, match="unframed"):
        parse_parent_record(b'{"type":"shutdown"}\n', PREFIX)
    with pytest.raises(ProtocolError, match="exceeds"):
        parse_parent_record(PREFIX + str(MAX_RECORD_BYTES + 1).encode() + b":", PREFIX)

    output = BytesIO()
    ProtocolWriter(PREFIX, output).write({"type": "bye"})
    assert output.getvalue() == encode_record(PREFIX, {"type": "bye"})


def test_stdio_loop_adapts_frames_and_shutdown_to_asgi() -> None:
    async def exercise_with_app() -> bytes:
        async def app(scope: dict[str, Any], receive: Any, send: Any) -> None:
            assert scope["path"] == "/ws/catalog"
            assert await receive() == {"type": "websocket.connect"}
            await send({"type": "websocket.accept"})
            message = await receive()
            await send({"type": "websocket.send", "text": message["text"]})
            assert await receive() == {"type": "websocket.disconnect", "code": 1000}

        events = [
            {
                "type": "open",
                "path": "/ws/catalog",
                "query": "",
                "headers": {},
                "subprotocols": [],
            },
            {"type": "frame", "data": '{"action":"ping"}'},
            {"type": "close", "code": 1000, "reason": ""},
            {"type": "shutdown"},
        ]
        input_stream = BytesIO(b"".join(encode_record(PREFIX, event) for event in events))
        output_stream = BytesIO()
        from pynect.worker import stdio

        original = stdio.load_object
        stdio.load_object = lambda _target: app  # type: ignore[assignment]
        try:
            await stdio.serve("unused:app", PREFIX, input_stream, output_stream)
        finally:
            stdio.load_object = original
        return output_stream.getvalue()

    records = decode_records(asyncio.run(exercise_with_app()))
    assert not any(thread.name == "pynect-stdio-reader" for thread in threading.enumerate())
    assert records == [
        {"type": "frame", "data": '{"action":"ping"}'},
        {"type": "close", "code": 1000, "reason": ""},
        {"type": "bye"},
    ]


def test_stdin_eof_is_a_graceful_shutdown(monkeypatch: pytest.MonkeyPatch) -> None:
    from pynect.worker import stdio

    async def app(_scope: dict[str, Any], _receive: Any, _send: Any) -> None:
        raise AssertionError("EOF must not open an application connection")

    monkeypatch.setattr(stdio, "load_object", lambda _target: app)
    output = BytesIO()
    asyncio.run(stdio.serve("unused:app", PREFIX, BytesIO(), output))
    assert decode_records(output.getvalue()) == [{"type": "bye"}]


def decode_records(data: bytes) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    offset = 0
    while offset < len(data):
        assert data.startswith(PREFIX, offset)
        length_start = offset + len(PREFIX)
        separator = data.index(b":", length_start)
        length = int(data[length_start:separator])
        payload_start = separator + 1
        records.append(json.loads(data[payload_start : payload_start + length]))
        offset = payload_start + length
    return records
