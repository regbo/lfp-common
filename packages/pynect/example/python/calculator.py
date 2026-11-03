"""Python functions exposed to the Bun and Node.js example."""

from collections.abc import Callable
from typing import TypedDict


class BenchmarkObject(TypedDict):
    id: int
    active: bool
    label: str


def add(left: float, right: float) -> float:
    """Add two numbers."""
    return left + right


def greet(
    name: str,
    modifier: Callable[[str], str] | None = None,
) -> str:
    """Build a short greeting and optionally modify it."""
    result = f"Hello, {name}, from Python!"
    return modifier(result) if modifier else result


def fibonacci(count: int) -> list[int]:
    """Return the first ``count`` Fibonacci numbers."""
    if count < 0:
        raise ValueError("count must be non-negative")

    values: list[int] = []
    left, right = 0, 1
    for _ in range(count):
        values.append(left)
        left, right = right, left + right
    return values


def create_benchmark_objects(count: int = 2000) -> list[BenchmarkObject]:
    """Create deterministic objects used by the callback benchmark."""
    return [
        {"id": index, "active": index % 3 == 0, "label": f"item-{index}"}
        for index in range(count)
    ]


def filter_benchmark_objects_native(
    values: list[BenchmarkObject],
) -> list[BenchmarkObject]:
    """Filter benchmark objects entirely in Python."""
    return [value for value in values if value["active"]]


def filter_benchmark_objects_callback(
    values: list[BenchmarkObject],
    predicate: Callable[[BenchmarkObject], bool],
) -> list[BenchmarkObject]:
    """Filter benchmark objects by invoking a JavaScript callback per object."""
    return [value for value in values if predicate(value)]
