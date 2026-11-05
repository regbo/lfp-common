"""HTTP-neutral model catalog data and operations."""

from typing import Literal

from pydantic import BaseModel

Provider = Literal["anthropic", "openai"]


class Model(BaseModel):
    id: str
    provider: Provider
    context_window: int


class ModelFilters(BaseModel):
    query: str | None = None
    provider: Provider | None = None


CATALOG = (
    Model(id="anthropic-cascade", provider="anthropic", context_window=200_000),
    Model(id="anthropic-ember", provider="anthropic", context_window=128_000),
    Model(id="anthropic-horizon", provider="anthropic", context_window=400_000),
    Model(id="anthropic-summit", provider="anthropic", context_window=32_768),
    Model(id="openai-atlas", provider="openai", context_window=128_000),
    Model(id="openai-cobalt", provider="openai", context_window=200_000),
    Model(id="openai-juniper", provider="openai", context_window=32_768),
    Model(id="openai-vector", provider="openai", context_window=8_192),
)
MODEL_COUNT = len(CATALOG)


def filter_models(filters: ModelFilters) -> list[Model]:
    query = filters.query.casefold() if filters.query else None
    return [
        model
        for model in CATALOG
        if (query is None or query in model.id.casefold())
        and (filters.provider is None or filters.provider == model.provider)
    ]
