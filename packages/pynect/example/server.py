import asyncio
import random
from collections.abc import AsyncIterator
from typing import Literal

from chanx.core.decorators import channel
from chanx.fast_channels.websocket import AsyncJsonWebsocketConsumer
from chanx.messages.base import BaseMessage
from coolname import generate_slug
from fastapi import FastAPI
from pydantic import BaseModel

from pynect_worker import ws_handler

Provider = Literal["anthropic", "openai"]
PROVIDERS: tuple[Provider, ...] = ("anthropic", "openai")
CONTEXT_WINDOWS = (8_192, 32_768, 128_000, 200_000, 400_000)
MODEL_COUNT = 8


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
    payload: list[Model]


class ListModelsStreamRequest(BaseMessage):
    action: Literal["list_models_stream"] = "list_models_stream"
    payload: ModelFilters


class ListModelsStreamResponse(BaseMessage):
    action: Literal["model"] = "model"
    payload: Model


def generate_catalog(count: int = MODEL_COUNT) -> list[Model]:
    models: list[Model] = []
    for _ in range(count):
        provider = random.choice(PROVIDERS)
        models.append(
            Model(
                id=f"{provider}-{generate_slug(3)}",
                provider=provider,
                context_window=random.choice(CONTEXT_WINDOWS),
            )
        )
    return models


CATALOG = generate_catalog()


def filter_models(filters: ModelFilters) -> list[Model]:
    query = filters.query.casefold() if filters.query else None
    return [
        model
        for model in CATALOG
        if (query is None or query in model.id.casefold())
        and (filters.provider is None or filters.provider == model.provider)
    ]


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


app = FastAPI(title="Pynect model catalog", version="1.0.0")
app.router.add_websocket_route("/ws/models", ModelsConsumer.as_asgi())
