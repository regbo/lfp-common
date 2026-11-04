"""Chanx handler decorators with iterator-aware streaming."""

import inspect
from collections.abc import AsyncGenerator, AsyncIterator, Generator, Iterator
from functools import wraps
from types import UnionType
from typing import Any, Union, get_args, get_origin, get_type_hints

from chanx.core.decorators import ws_handler as chanx_ws_handler
from chanx.messages.base import BaseMessage
from chanx.messages.outgoing import CompleteMessage

_STREAM_ORIGINS = {AsyncGenerator, AsyncIterator, Generator, Iterator}
_STREAM_OPERATIONS: set[tuple[str, str]] = set()


def ws_handler(func: Any = None, **options: Any) -> Any:
    """Decorate a Chanx handler, forwarding annotated iterators automatically."""

    def decorate(handler: Any) -> Any:
        item_type = _stream_item_type(get_type_hints(handler).get("return"))
        if item_type is None:
            return chanx_ws_handler(handler, **options)

        output_type = options.get("output_type") or item_type
        _validate_output_type(output_type, handler.__name__)

        @wraps(handler)
        async def forward_stream(*args: Any, **kwargs: Any) -> None:
            result = handler(*args, **kwargs)
            if inspect.isawaitable(result):
                result = await result

            consumer = args[0]
            if isinstance(result, AsyncIterator):
                async for message in result:
                    await consumer.send_message(message)
            elif isinstance(result, Iterator):
                for message in result:
                    await consumer.send_message(message)
            else:
                raise TypeError(
                    f"Streaming handler {handler.__name__} returned {type(result).__name__}, expected an iterator."
                )

            if not consumer.should_send_completion:
                await consumer.send_message(CompleteMessage())

        decorated = chanx_ws_handler(
            forward_stream,
            **{**options, "output_type": output_type},
        )
        handler_info = decorated._ws_handler_info  # type: ignore[attr-defined]
        handler_info["x_pynect_stream"] = True
        _STREAM_OPERATIONS.add((handler_info["action"], handler_info["input_type"].__name__))
        return decorated

    return decorate if func is None else decorate(func)


def stream_operations() -> frozenset[tuple[str, str]]:
    """Return operation and request type pairs for iterator handlers."""
    return frozenset(_STREAM_OPERATIONS)


def _stream_item_type(annotation: Any) -> Any | None:
    origin = get_origin(annotation)
    if origin not in _STREAM_ORIGINS:
        return None
    arguments = get_args(annotation)
    return arguments[0] if arguments else None


def _validate_output_type(output_type: Any, handler_name: str) -> None:
    if isinstance(output_type, list | tuple):
        types = tuple(output_type)
    elif get_origin(output_type) in (UnionType, Union):
        types = get_args(output_type)
    else:
        types = (output_type,)
    if not types or any(not (inspect.isclass(candidate) and issubclass(candidate, BaseMessage)) for candidate in types):
        raise TypeError(f"Streaming handler {handler_name} must yield BaseMessage subclasses.")
