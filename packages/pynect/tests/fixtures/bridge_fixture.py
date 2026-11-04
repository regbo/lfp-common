from __future__ import annotations

import asyncio
import gc
import os
from collections.abc import Callable, Iterator
from typing import Any, TypedDict


class BridgeRow(TypedDict):
    id: int
    active: bool


_stored_callback: Callable[[int], Any] | None = None
_released_iterators = 0


def add(left: Any, right: Any) -> Any:
    return left + right


def describe(value: str, *, suffix: str = "") -> str:
    return value + suffix


async def async_add(left: int, right: int) -> int:
    await asyncio.sleep(0)
    return left + right


def call_callback(callback: Callable[[int], Any], value: int) -> Any:
    return callback(value)


def store_callback(callback: Callable[[int], Any]) -> None:
    global _stored_callback
    _stored_callback = callback


def call_stored_callback(value: int) -> Any:
    if _stored_callback is None:
        raise RuntimeError("No callback is stored")
    return _stored_callback(value)


def clear_stored_callback() -> None:
    global _stored_callback
    _stored_callback = None
    gc.collect()


def filter_rows(
    rows: list[BridgeRow], callback: Callable[[BridgeRow], bool]
) -> list[BridgeRow]:
    return [row for row in rows if callback(row)]


def count(limit: int) -> Iterator[int]:
    yield from range(limit)


def tracked_iterable(limit: int) -> TrackedIterable:
    return TrackedIterable(limit)


def released_iterator_count() -> int:
    return _released_iterators


def binary_payload() -> bytes:
    return b"\x00pynect\xff"


def terminate_worker() -> None:
    os._exit(23)


class Counter:
    def __init__(self, value: int = 0) -> None:
        self.value = value

    def increment(self, amount: int = 1) -> int:
        self.value += amount
        return self.value


class TrackedIterable:
    def __init__(self, limit: int) -> None:
        self.limit = limit

    def __iter__(self) -> TrackedIterator:
        return TrackedIterator(self.limit)


class TrackedIterator:
    def __init__(self, limit: int) -> None:
        self.current = 0
        self.limit = limit

    def __iter__(self) -> TrackedIterator:
        return self

    def __next__(self) -> int:
        if self.current >= self.limit:
            raise StopIteration
        value = self.current
        self.current += 1
        return value

    def __del__(self) -> None:
        global _released_iterators
        _released_iterators += 1
