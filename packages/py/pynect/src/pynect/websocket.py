"""Chanx WebSocket consumer with transparent iterator handler support."""

from typing import Any

from chanx.core.websocket import ChanxWebsocketConsumerMixin
from chanx.messages.base import BaseMessage
from fast_channels.consumer import AsyncJsonWebsocketConsumer as FastChannelsAsyncJsonWebsocketConsumer
from fast_channels.layers import get_channel_layer
from typing_extensions import TypeVar

from pynect.handlers import _adapt_handler

ReceiveEvent = TypeVar("ReceiveEvent", bound=BaseMessage, default=BaseMessage)


class AsyncJsonWebsocketConsumer(ChanxWebsocketConsumerMixin[ReceiveEvent], FastChannelsAsyncJsonWebsocketConsumer):
    """Adapt iterator-annotated Chanx handlers before Chanx registers them."""

    # Compose the runtime bases directly so stdio applications do not import
    # Chanx's FastAPI documentation package through chanx.fast_channels.
    channel_layer_alias: str
    get_channel_layer = get_channel_layer  # type: ignore[assignment]

    def __init_subclass__(cls, **kwargs: Any) -> None:
        for name, handler in tuple(cls.__dict__.items()):
            if hasattr(handler, "_ws_handler_info"):
                setattr(cls, name, _adapt_handler(handler))

        super().__init_subclass__(**kwargs)
