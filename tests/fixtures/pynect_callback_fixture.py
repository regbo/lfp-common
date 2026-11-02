from collections.abc import Callable
from typing import Any

_retained_callback: Callable[[Any], Any] | None = None


def invoke(callback: Callable[[Any], Any], value: Any) -> Any:
    return callback(value)


def retain(callback: Callable[[Any], Any]) -> None:
    global _retained_callback
    _retained_callback = callback


def invoke_retained(value: Any) -> Any:
    if _retained_callback is None:
        raise RuntimeError("No callback has been retained")
    return _retained_callback(value)


def double(value: int) -> int:
    return value * 2
