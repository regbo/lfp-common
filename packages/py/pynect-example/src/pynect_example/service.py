"""ASGI WebSocket service for the model catalog."""

import asyncio
import random
from collections.abc import AsyncIterator
from typing import Literal

from chanx.core.decorators import channel, ws_handler
from chanx.messages.base import BaseMessage
from pynect import AsyncJsonWebsocketConsumer

from pynect_example.catalog import Model, ModelFilters, filter_models


class ListModelsRequest(BaseMessage):
    action: Literal["list_models"] = "list_models"
    payload: ModelFilters


class ListModelsResponse(BaseMessage):
    action: Literal["models"] = "models"
    payload: list[Model]


class ListModelsStreamRequest(BaseMessage):
    action: Literal["list_models_stream"] = "list_models_stream"
    payload: ModelFilters


class ListModelsStreamResponse(BaseMessage):
    action: Literal["model"] = "model"
    payload: Model


@channel(name="models", description="Read the model catalog")
class ModelsConsumer(AsyncJsonWebsocketConsumer):
    @ws_handler
    async def list_models(self, message: ListModelsRequest) -> ListModelsResponse:
        return ListModelsResponse(payload=filter_models(message.payload))

    @ws_handler
    async def list_models_stream(self, message: ListModelsStreamRequest) -> AsyncIterator[ListModelsStreamResponse]:
        for model in filter_models(message.payload):
            await asyncio.sleep(random.uniform(0.5, 2))
            yield ListModelsStreamResponse(payload=model)


app = ModelsConsumer.as_asgi()
