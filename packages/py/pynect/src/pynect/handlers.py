"""Iterator adaptation shared by Pynect consumers and legacy decorators."""

import inspect
import warnings
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
    """Decorate a Chanx handler with the pre-0.9 Pynect streaming adapter."""

    warnings.warn(
        "pynect.ws_handler is deprecated; import ws_handler from chanx.core.decorators "
        "and subclass pynect.AsyncJsonWebsocketConsumer instead.",
        DeprecationWarning,
        stacklevel=2,
    )

    def decorate(handler: Any) -> Any:
        return _adapt_handler(chanx_ws_handler(handler, **options))

    return decorate if func is None else decorate(func)


def _adapt_handler(handler: Any) -> Any:
    """Adapt synchronous and iterator-annotated Chanx handlers."""
    handler_info = getattr(handler, "_ws_handler_info", None)
    if handler_info is None or handler_info.get("x_pynect_stream"):
        return handler

    original = inspect.unwrap(handler)
    item_type = _stream_item_type(get_type_hints(original).get("return"))
    if item_type is None:
        return _adapt_sync_handler(handler, original, handler_info)

    declared_output_type = handler_info.get("output_type")
    output_type = (
        item_type if _stream_item_type(declared_output_type) is not None else declared_output_type or item_type
    )
    _validate_output_type(output_type, original.__name__)
    handler_info["output_type"] = output_type
    handler_info["x_pynect_stream"] = True
    _STREAM_OPERATIONS.add((handler_info["action"], handler_info["input_type"].__name__))

    @wraps(original)
    async def forward_stream(*args: Any, **kwargs: Any) -> None:
        result = original(*args, **kwargs)
        if inspect.isawaitable(result):
            result = await result

        consumer = args[0]
        completed = False
        try:
            if isinstance(result, AsyncIterator):
                async for message in result:
                    await consumer.send_message(message)
            elif isinstance(result, Iterator):
                for message in result:
                    await consumer.send_message(message)
            else:
                raise TypeError(
                    f"Streaming handler {original.__name__} returned {type(result).__name__}, expected an iterator."
                )
            completed = True
        finally:
            await _close_iterator(result)

        if completed and not consumer.should_send_completion:
            await consumer.send_message(CompleteMessage())

    forward_stream._ws_handler_info = handler_info  # type: ignore[attr-defined]
    return forward_stream


def _adapt_sync_handler(handler: Any, original: Any, handler_info: Any) -> Any:
    """Wrap a synchronous handler so Chanx can await it normally."""
    if inspect.iscoroutinefunction(original):
        return handler

    @wraps(original)
    async def call_sync(*args: Any, **kwargs: Any) -> Any:
        result = original(*args, **kwargs)
        return await result if inspect.isawaitable(result) else result

    call_sync._ws_handler_info = handler_info  # type: ignore[attr-defined]
    return call_sync


async def _close_iterator(iterator: Any) -> None:
    """Deterministically release iterator resources after completion or failure."""
    if close_async := getattr(iterator, "aclose", None):
        await close_async()
    elif close := getattr(iterator, "close", None):
        close()


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
