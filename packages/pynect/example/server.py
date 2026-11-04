import asyncio
import random
from collections.abc import AsyncIterator
from typing import Literal

from chanx.core.decorators import channel, ws_handler
from chanx.fast_channels.websocket import AsyncJsonWebsocketConsumer
from chanx.messages.base import BaseMessage
from fastapi import FastAPI
from pydantic import BaseModel

Provider = Literal["anthropic", "openai"]


class Model(BaseModel):
    id: str
    provider: Provider
    context_window: int


class ModelFilters(BaseModel):
    query: str | None = None
    provider: Provider | None = None


class ListModelsRequest(BaseMessage):
    action: Literal["list_models"] = "list_models"
    payload: ModelFilters


class ListModelsResponse(BaseMessage):
    action: Literal["models"] = "models"
    payload: Model


class ListModelsComplete(BaseMessage):
    action: Literal["models_complete"] = "models_complete"
    payload: int


CATALOG = [
    Model(id="claude-sonnet", provider="anthropic", context_window=200_000),
    Model(id="gpt-5-mini", provider="openai", context_window=400_000),
]


async def generate_models(
    message: ListModelsRequest,
) -> AsyncIterator[ListModelsResponse]:
    query = message.payload.query.casefold() if message.payload.query else None
    for model in CATALOG:
        if (query is None or query in model.id.casefold()) and (
            message.payload.provider is None or message.payload.provider == model.provider
        ):
            await asyncio.sleep(random.uniform(0.05, 0.2))
            yield ListModelsResponse(payload=model)


@channel(name="models", description="Read the model catalog")
class ModelsConsumer(AsyncJsonWebsocketConsumer):
    @ws_handler(output_type=(ListModelsResponse, ListModelsComplete))
    async def list_models(self, message: ListModelsRequest) -> None:
        count = 0
        async for response in generate_models(message):
            count += 1
            await self.send_message(response)
        await self.send_message(ListModelsComplete(payload=count))


app = FastAPI(title="Pynect model catalog", version="1.0.0")
app.router.add_websocket_route("/ws/models", ModelsConsumer.as_asgi())
