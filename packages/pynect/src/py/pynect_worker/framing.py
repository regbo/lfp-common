"""Shared MessagePack framing for IPC and WebSocket transports."""

from __future__ import annotations

from typing import Any

import msgpack


def encode_frame(message: dict[str, Any], max_frame_bytes: int) -> bytes:
    """Encode one length-prefixed RPC message."""

    payload = msgpack.packb(message, use_bin_type=True)
    if len(payload) > max_frame_bytes:
        raise ValueError(f"RPC frame exceeds {max_frame_bytes} bytes")
    return len(payload).to_bytes(4, "big") + payload


def decode_frame(frame: bytes, max_frame_bytes: int) -> dict[str, Any]:
    """Decode exactly one length-prefixed RPC message."""

    if len(frame) < 4:
        raise ValueError("RPC frame is missing its length prefix")
    length = int.from_bytes(frame[:4], "big")
    if length > max_frame_bytes:
        raise ValueError(f"RPC frame exceeds {max_frame_bytes} bytes")
    if length != len(frame) - 4:
        raise ValueError("RPC frame length is invalid")
    value = msgpack.unpackb(frame[4:], raw=False, strict_map_key=False)
    if not isinstance(value, dict):
        raise TypeError("RPC message must be a map")
    return value
