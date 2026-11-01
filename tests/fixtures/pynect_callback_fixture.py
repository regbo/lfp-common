from collections.abc import Callable
from typing import Any


def invoke(callback: Callable[[Any], Any], value: Any) -> Any:
    return callback(value)


def double(value: int) -> int:
    return value * 2
