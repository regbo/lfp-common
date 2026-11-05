"""HTTP-neutral application models and deterministic demo behavior."""

from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, Field

WeatherCondition = Literal["clear", "cloudy", "rain", "windy"]


class WeatherQuery(BaseModel):
    """Select the location for a weather snapshot."""

    location: str = Field(
        default="New York, NY",
        min_length=1,
        max_length=100,
        description="City or region to observe.",
    )


class WeatherWatch(WeatherQuery):
    """Configure a finite stream of changing weather observations."""

    updates: int = Field(default=5, ge=1, le=20, description="Number of changes to emit.")
    interval: float = Field(
        default=0.25,
        ge=0,
        le=5,
        description="Delay between changes in seconds.",
    )


class WeatherSnapshot(BaseModel):
    """One simulated weather observation."""

    location: str
    temperature_c: float
    condition: WeatherCondition
    humidity_percent: int
    observed_at: datetime


class WeatherChange(BaseModel):
    """One item emitted by the weather-change generator."""

    sequence: int
    weather: WeatherSnapshot
    summary: str


class ChatPrompt(BaseModel):
    """One user turn submitted to the Python model runtime."""

    content: str = Field(min_length=1, max_length=2_000)


class ChatModelStatus(BaseModel):
    """One model-loading lifecycle change emitted to the connected client."""

    stage: Literal["loading", "cache_hit", "downloading", "downloaded", "ready", "error"]
    message: str


class ChatMessage(BaseModel):
    """One user or assistant turn stored by Python."""

    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=2_000)


class ChatTranscript(BaseModel):
    """Connection-local conversation state returned to TypeScript."""

    messages: list[ChatMessage]
    turn: int


def observe_weather(query: WeatherQuery, sequence: int = 0) -> WeatherSnapshot:
    """Build repeatable synthetic weather without relying on a network API."""
    seed = sum((index + 1) * ord(character) for index, character in enumerate(query.location.casefold()))
    conditions: tuple[WeatherCondition, ...] = ("clear", "cloudy", "rain", "windy")
    temperature_offsets = (0.0, 0.8, -0.6, 1.1, -0.3)
    temperature_c = round(8 + (seed % 180) / 10 + temperature_offsets[sequence % len(temperature_offsets)], 1)
    return WeatherSnapshot(
        location=query.location,
        temperature_c=temperature_c,
        condition=conditions[(seed + sequence) % len(conditions)],
        humidity_percent=35 + ((seed + sequence * 7) % 56),
        observed_at=datetime.now(UTC),
    )
