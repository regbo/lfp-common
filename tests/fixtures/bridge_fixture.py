from __future__ import annotations

import asyncio
from collections.abc import Callable, Iterator
from typing import Any, TypedDict


class BridgeRow(TypedDict):
    id: int
    active: bool


def add(left: Any, right: Any) -> Any:
    return left + right


def describe(value: str, *, suffix: str = "") -> str:
    return value + suffix


async def async_add(left: int, right: int) -> int:
    await asyncio.sleep(0)
    return left + right


def call_callback(callback: Callable[[int], Any], value: int) -> Any:
    return callback(value)


def filter_rows(
    rows: list[BridgeRow], callback: Callable[[BridgeRow], bool]
) -> list[BridgeRow]:
    return [row for row in rows if callback(row)]


def count(limit: int) -> Iterator[int]:
    yield from range(limit)


class Counter:
    def __init__(self, value: int = 0) -> None:
        self.value = value

    def increment(self, amount: int = 1) -> int:
        self.value += amount
        return self.value
