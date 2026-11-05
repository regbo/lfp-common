"""Typed marker-and-length records for the owned stdio transport."""

import json
import os
import sys
import threading
from collections.abc import Mapping
from io import BytesIO
from typing import Any, BinaryIO, Literal, TypedDict

MAX_RECORD_BYTES = 16 * 1024 * 1024
PROTOCOL_VERSION = 1


class ProtocolError(ValueError):
    """A prefixed record violates the stdio transport contract."""


class OpenEvent(TypedDict):
    """Open the worker's one virtual WebSocket connection."""

    type: Literal["open"]
    path: str
    query: str
    headers: dict[str, str]
    subprotocols: list[str]


class FrameEvent(TypedDict):
    """Carry one opaque Chanx text frame."""

    type: Literal["frame"]
    data: str


class CloseEvent(TypedDict):
    """Close the virtual WebSocket connection."""

    type: Literal["close"]
    code: int
    reason: str


class ShutdownEvent(TypedDict):
    """Request graceful worker termination."""

    type: Literal["shutdown"]


ParentEvent = OpenEvent | FrameEvent | CloseEvent | ShutdownEvent


def prefix_from_environment() -> bytes:
    """Read and validate the complete random record prefix."""
    value = os.environ.get("PYNECT_STDIO_PREFIX")
    if not value:
        raise RuntimeError("PYNECT_STDIO_PREFIX is required")
    try:
        prefix = value.encode("ascii")
    except UnicodeEncodeError as error:
        raise RuntimeError("PYNECT_STDIO_PREFIX must be ASCII") from error
    if not value.startswith("@pynect:") or not value.endswith(" "):
        raise RuntimeError("PYNECT_STDIO_PREFIX has an invalid shape")
    return prefix


def encode_record(prefix: bytes, event: Mapping[str, Any]) -> bytes:
    """Serialize a marker, decimal byte length, separator, and JSON payload."""
    payload = json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode()
    if len(payload) > MAX_RECORD_BYTES:
        raise ProtocolError(f"Pynect record exceeds {MAX_RECORD_BYTES} bytes")
    return prefix + str(len(payload)).encode("ascii") + b":" + payload


def parse_parent_record(record: bytes, prefix: bytes) -> ParentEvent:
    """Parse one complete in-memory record and reject trailing bytes."""
    input_stream = BytesIO(record)
    event = read_parent_event(input_stream, prefix)
    if event is None:
        raise ProtocolError("stdin ended before a Pynect protocol record")
    if input_stream.read(1):
        raise ProtocolError("Pynect protocol record contains trailing bytes")
    return event


def read_parent_event(input_stream: BinaryIO, prefix: bytes) -> ParentEvent | None:
    """Read exactly one length-prefixed event, independent of line boundaries."""
    marker = _read_exact(input_stream, len(prefix), allow_clean_eof=True)
    if marker is None:
        return None
    if marker != prefix:
        raise ProtocolError("stdin contained an unframed Pynect protocol record")
    digits = bytearray()
    while True:
        byte = _read_exact(input_stream, 1)
        if byte == b":":
            break
        if byte is None or byte < b"0" or byte > b"9" or len(digits) >= 10:
            raise ProtocolError("stdin contained an invalid Pynect record length")
        digits.extend(byte)
    if not digits:
        raise ProtocolError("stdin contained an empty Pynect record length")
    length = int(digits)
    if length > MAX_RECORD_BYTES:
        raise ProtocolError(f"stdin Pynect record exceeds {MAX_RECORD_BYTES} bytes")
    payload = _read_exact(input_stream, length)
    if payload is None:
        raise ProtocolError("stdin ended during a Pynect protocol record")
    try:
        value = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProtocolError("stdin contained malformed Pynect protocol JSON") from error
    return _validate_parent_event(value)


def _validate_parent_event(value: object) -> ParentEvent:
    if not isinstance(value, dict):
        raise ProtocolError("Pynect protocol events must be JSON objects")

    event_type = value.get("type")
    if event_type == "open":
        path = _string(value.get("path"), "open.path")
        if not path.startswith("/"):
            raise ProtocolError("open.path must be absolute")
        headers_value = value.get("headers")
        if not isinstance(headers_value, dict) or not all(
            isinstance(name, str) and isinstance(header, str) for name, header in headers_value.items()
        ):
            raise ProtocolError("open.headers must map strings to strings")
        subprotocols_value = value.get("subprotocols")
        if not isinstance(subprotocols_value, list) or not all(
            isinstance(subprotocol, str) for subprotocol in subprotocols_value
        ):
            raise ProtocolError("open.subprotocols must be a string array")
        return {
            "type": "open",
            "path": path,
            "query": _string(value.get("query"), "open.query"),
            "headers": headers_value,
            "subprotocols": subprotocols_value,
        }
    if event_type == "frame":
        return {"type": "frame", "data": _string(value.get("data"), "frame.data")}
    if event_type == "close":
        code = _integer(value.get("code"), "close.code")
        if not 0 <= code <= 4999:
            raise ProtocolError("close.code is out of range")
        return {
            "type": "close",
            "code": code,
            "reason": _string(value.get("reason"), "close.reason"),
        }
    if event_type == "shutdown":
        return {"type": "shutdown"}
    raise ProtocolError(f"unknown Pynect protocol event type: {event_type!r}")


def _read_exact(input_stream: BinaryIO, length: int, *, allow_clean_eof: bool = False) -> bytes | None:
    chunks: list[bytes] = []
    remaining = length
    while remaining > 0:
        chunk = input_stream.read(remaining)
        if not chunk:
            if allow_clean_eof and remaining == length:
                return None
            raise ProtocolError("stdin ended during a Pynect protocol record")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


class ProtocolWriter:
    """Serialize complete protocol writes across application tasks and threads."""

    def __init__(self, prefix: bytes, output: BinaryIO | None = None) -> None:
        self._prefix = prefix
        self._output = output or sys.stdout.buffer
        self._lock = threading.Lock()

    def write(self, event: Mapping[str, Any]) -> None:
        """Write and explicitly flush one event without interleaving another."""
        record = encode_record(self._prefix, event)
        with self._lock:
            self._output.write(record)
            self._output.flush()


def _string(value: object, field: str) -> str:
    if not isinstance(value, str):
        raise ProtocolError(f"{field} must be a string")
    return value


def _integer(value: object, field: str) -> int:
    if type(value) is not int:
        raise ProtocolError(f"{field} must be an integer")
    return value
