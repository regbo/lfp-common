"""Chanx WebSocket consumer with transparent iterator handler support."""

from typing import Any

from chanx.fast_channels.websocket import AsyncJsonWebsocketConsumer as ChanxAsyncJsonWebsocketConsumer

from pynect_worker.handlers import _adapt_handler


class AsyncJsonWebsocketConsumer(ChanxAsyncJsonWebsocketConsumer):
    """Adapt iterator-annotated Chanx handlers before Chanx registers them."""

    def __init_subclass__(cls, **kwargs: Any) -> None:
        for name, handler in tuple(cls.__dict__.items()):
            if hasattr(handler, "_ws_handler_info"):
                setattr(cls, name, _adapt_handler(handler))

        super().__init_subclass__(**kwargs)
