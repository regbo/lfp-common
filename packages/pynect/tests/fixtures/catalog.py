from collections.abc import AsyncIterator
from typing import Literal

from chanx.core.decorators import channel
from chanx.fast_channels.websocket import AsyncJsonWebsocketConsumer
from chanx.messages.base import BaseMessage
from fastapi import FastAPI
from pydantic import BaseModel

from pynect_worker import ws_handler


class PingPayload(BaseModel):
    value: str


class PingRequest(BaseMessage):
    action: Literal["ping"] = "ping"
    payload: PingPayload


class PongResponse(BaseMessage):
    action: Literal["pong"] = "pong"
    payload: PingPayload


class WatchRequest(BaseMessage):
    action: Literal["watch"] = "watch"
    payload: PingPayload


class WatchResponse(BaseMessage):
    action: Literal["watched"] = "watched"
    payload: PingPayload


@channel(name="catalog", description="Pynect generation fixture")
class CatalogConsumer(AsyncJsonWebsocketConsumer):
    @ws_handler
    async def ping(self, message: PingRequest) -> PongResponse:
        return PongResponse(payload=message.payload)

    @ws_handler
    async def watch(self, message: WatchRequest) -> AsyncIterator[WatchResponse]:
        yield WatchResponse(payload=message.payload)


app = FastAPI(title="Pynect fixture", version="1.0.0")
app.router.add_websocket_route("/ws/catalog", CatalogConsumer.as_asgi())
