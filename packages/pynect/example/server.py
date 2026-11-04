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
    payload: list[Model]


CATALOG = [
    Model(id="claude-sonnet", provider="anthropic", context_window=200_000),
    Model(id="gpt-5-mini", provider="openai", context_window=400_000),
]


@channel(name="models", description="Read the model catalog")
class ModelsConsumer(AsyncJsonWebsocketConsumer):
    @ws_handler
    async def list_models(self, message: ListModelsRequest) -> ListModelsResponse:
        query = message.payload.query.casefold() if message.payload.query else None
        matches = [
            model
            for model in CATALOG
            if (query is None or query in model.id.casefold())
            and (message.payload.provider is None or message.payload.provider == model.provider)
        ]
        return ListModelsResponse(payload=matches)


app = FastAPI(title="Pynect model catalog", version="1.0.0")
app.router.add_websocket_route("/ws/models", ModelsConsumer.as_asgi())
