"""HTTP-neutral Chanx service used by local stdio and remote WebSockets."""

import asyncio
from collections.abc import AsyncIterator
from typing import Literal

from chanx.core.decorators import channel, ws_handler
from chanx.messages.base import BaseMessage
from pynect import AsyncJsonWebsocketConsumer

from pynect_example.chat import generate_reply
from pynect_example.domain import (
    ChatMessage,
    ChatModelStatus,
    ChatPrompt,
    ChatTranscript,
    WeatherChange,
    WeatherQuery,
    WeatherSnapshot,
    WeatherWatch,
    observe_weather,
)


class GetWeatherRequest(BaseMessage):
    action: Literal["get_weather"] = "get_weather"
    payload: WeatherQuery


class GetWeatherResponse(BaseMessage):
    action: Literal["weather"] = "weather"
    payload: WeatherSnapshot


class WatchWeatherRequest(BaseMessage):
    action: Literal["watch_weather"] = "watch_weather"
    payload: WeatherWatch


class WatchWeatherResponse(BaseMessage):
    action: Literal["weather_changed"] = "weather_changed"
    payload: WeatherChange


class ChatRequest(BaseMessage):
    action: Literal["chat"] = "chat"
    payload: ChatPrompt


class ChatResponse(BaseMessage):
    action: Literal["chat_transcript"] = "chat_transcript"
    payload: ChatTranscript


class ChatStatusEvent(BaseMessage):
    action: Literal["chat_status"] = "chat_status"
    payload: ChatModelStatus


@channel(name="demo", description="Weather queries, event streams, and stateful chat")
class DemoConsumer(AsyncJsonWebsocketConsumer):
    emits = [ChatStatusEvent]

    @ws_handler
    async def get_weather(self, message: GetWeatherRequest) -> GetWeatherResponse:
        return GetWeatherResponse(payload=observe_weather(message.payload))

    @ws_handler
    async def watch_weather(self, message: WatchWeatherRequest) -> AsyncIterator[WatchWeatherResponse]:
        for sequence in range(1, message.payload.updates + 1):
            if message.payload.interval:
                await asyncio.sleep(message.payload.interval)
            weather = observe_weather(message.payload, sequence)
            yield WatchWeatherResponse(
                payload=WeatherChange(
                    sequence=sequence,
                    weather=weather,
                    summary=f"{weather.location} changed to {weather.condition} at {weather.temperature_c} C",
                )
            )

    @ws_handler
    async def chat(self, message: ChatRequest) -> ChatResponse:
        messages: list[ChatMessage] = getattr(self, "_chat_messages", [])
        messages.append(ChatMessage(role="user", content=message.payload.content))
        reply = await asyncio.to_thread(generate_reply, messages)
        messages.append(ChatMessage(role="assistant", content=reply))
        self._chat_messages = messages
        turn = sum(item.role == "user" for item in messages)
        return ChatResponse(payload=ChatTranscript(messages=messages, turn=turn))


app = DemoConsumer.as_asgi()
