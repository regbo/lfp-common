"""Transport-neutral RPC connection contracts and local IPC implementation."""

from __future__ import annotations

import os
import socket
import threading
import time
from abc import ABC, abstractmethod
from typing import Any

from .framing import decode_frame, encode_frame
from .models import MAX_LOCAL_FRAME_BYTES


class RpcConnection(ABC):
    """A message-oriented connection consumed by the Python bridge."""

    @abstractmethod
    def read(self) -> dict[str, Any] | None:
        """Read one message, or return ``None`` after a clean disconnect."""

    @abstractmethod
    def write(self, message: dict[str, Any]) -> None:
        """Write one message atomically."""

    @abstractmethod
    def close(self) -> None:
        """Release the underlying transport."""


class FramedConnection(RpcConnection):
    """Length-prefixed Unix-socket or Windows named-pipe connection."""

    def __init__(self, endpoint: str) -> None:
        self._write_lock = threading.Lock()
        self._socket: socket.socket | None = None
        self._pipe_handle: int | None = None
        if os.name == "nt":
            self._pipe_handle = self._open_windows_pipe(endpoint)
        else:
            connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            connection.connect(endpoint)
            self._socket = connection

    @staticmethod
    def _open_windows_pipe(endpoint: str) -> int:
        import _winapi

        deadline = time.monotonic() + 10
        while True:
            try:
                _winapi.WaitNamedPipe(endpoint, 1000)
                return _winapi.CreateFile(
                    endpoint,
                    _winapi.GENERIC_READ | _winapi.GENERIC_WRITE,
                    0,
                    _winapi.NULL,
                    _winapi.OPEN_EXISTING,
                    _winapi.FILE_FLAG_OVERLAPPED,
                    _winapi.NULL,
                )
            except OSError as error:
                if time.monotonic() >= deadline:
                    raise
                if error.winerror not in {
                    _winapi.ERROR_PIPE_BUSY,
                    _winapi.ERROR_SEM_TIMEOUT,
                }:
                    raise
                time.sleep(0.025)

    def read(self) -> dict[str, Any] | None:
        header = self._read_exact(4)
        if header is None:
            return None
        length = int.from_bytes(header, "big")
        if length > MAX_LOCAL_FRAME_BYTES:
            raise ValueError(f"RPC frame exceeds {MAX_LOCAL_FRAME_BYTES} bytes")
        payload = self._read_exact(length)
        if payload is None:
            raise EOFError("IPC connection closed inside a frame")
        return decode_frame(header + payload, MAX_LOCAL_FRAME_BYTES)

    def write(self, message: dict[str, Any]) -> None:
        frame = encode_frame(message, MAX_LOCAL_FRAME_BYTES)
        with self._write_lock:
            if self._pipe_handle is not None:
                self._write_windows(frame)
                return
            if self._socket is not None:
                self._socket.sendall(frame)
                return
            raise EOFError("IPC connection is closed")

    def _read_exact(self, length: int) -> bytes | None:
        chunks: list[bytes] = []
        remaining = length
        while remaining:
            chunk = self._socket.recv(remaining) if self._socket is not None else self._read_windows(remaining)
            if not chunk:
                if not chunks:
                    return None
                raise EOFError("IPC connection closed during read")
            chunks.append(bytes(chunk))
            remaining -= len(chunk)
        return b"".join(chunks)

    def _read_windows(self, length: int) -> bytes:
        import _winapi

        try:
            overlapped, _ = _winapi.ReadFile(
                self._pipe_handle,
                length,
                overlapped=True,
            )
            overlapped.GetOverlappedResult(True)
            return bytes(overlapped.getbuffer())
        except OSError as error:
            if error.winerror == _winapi.ERROR_BROKEN_PIPE:
                return b""
            raise

    def _write_windows(self, value: bytes) -> None:
        import _winapi

        overlapped, _ = _winapi.WriteFile(
            self._pipe_handle,
            value,
            overlapped=True,
        )
        written, error = overlapped.GetOverlappedResult(True)
        if error:
            raise OSError(error, "Windows named pipe write failed")
        if written != len(value):
            raise EOFError("Windows named pipe closed during write")

    def close(self) -> None:
        if self._socket is not None:
            self._socket.close()
            self._socket = None
        if self._pipe_handle is not None:
            import _winapi

            _winapi.CloseHandle(self._pipe_handle)
            self._pipe_handle = None
