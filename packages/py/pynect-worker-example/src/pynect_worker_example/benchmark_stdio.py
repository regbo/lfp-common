"""Minimal marker-and-length worker for the Bun/Python stdio benchmark."""

import json
import os
import sys
from typing import Any


def emit(prefix: bytes, event: dict[str, Any]) -> None:
    """Write one complete protocol record and make it immediately visible."""
    payload = json.dumps(event, separators=(",", ":")).encode()
    sys.stdout.buffer.write(prefix + str(len(payload)).encode() + b":" + payload)
    sys.stdout.buffer.flush()


def read_exact(length: int) -> bytes | None:
    """Read one exact byte count, returning None only for clean EOF."""
    chunks: list[bytes] = []
    remaining = length
    while remaining:
        chunk = sys.stdin.buffer.read(remaining)
        if not chunk:
            if remaining == length:
                return None
            raise RuntimeError("stdin ended during a protocol record")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_event(prefix: bytes) -> dict[str, Any] | None:
    """Read one marker and byte-length-delimited JSON payload."""
    marker = read_exact(len(prefix))
    if marker is None:
        return None
    if marker != prefix:
        raise RuntimeError("stdin contained an unframed protocol record")
    digits = bytearray()
    while (byte := read_exact(1)) != b":":
        if byte is None or not byte.isdigit():
            raise RuntimeError("stdin contained an invalid record length")
        digits.extend(byte)
    payload = read_exact(int(digits))
    if payload is None:
        raise RuntimeError("stdin ended during a protocol record")
    event = json.loads(payload)
    if not isinstance(event, dict):
        raise TypeError("protocol event must be a JSON object")
    return event


def main() -> None:
    """Reply to length-framed pings until Bun closes the worker."""
    prefix_value = os.environ.get("PYNECT_STDIO_PREFIX")
    if not prefix_value:
        raise RuntimeError("PYNECT_STDIO_PREFIX is required")
    prefix = prefix_value.encode("ascii")
    emit(prefix, {"type": "hello", "protocol": 1, "pid": os.getpid()})

    while (event := read_event(prefix)) is not None:
        event_type = event.get("type")
        event_id = event.get("id")
        if not isinstance(event_id, int):
            raise TypeError("protocol event id must be an integer")
        if event_type == "ping":
            emit(prefix, {"type": "pong", "id": event_id})
        elif event_type == "shutdown":
            emit(prefix, {"type": "bye", "id": event_id})
            return
        else:
            raise RuntimeError(f"unknown protocol event type: {event_type!r}")


if __name__ == "__main__":
    main()
