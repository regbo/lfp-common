import asyncio
from collections.abc import AsyncIterator, Iterator
from typing import Literal

import pytest
from chanx.core.decorators import ws_handler
from chanx.messages.base import BaseMessage
from chanx.messages.outgoing import CompleteMessage, ErrorMessage
from pydantic import BaseModel

from pynect_worker import AsyncJsonWebsocketConsumer
from pynect_worker import ws_handler as pynect_ws_handler


class Payload(BaseModel):
    value: str


class Request(BaseMessage):
    action: Literal["stream"] = "stream"
    payload: Payload


class SyncRequest(BaseMessage):
    action: Literal["sync"] = "sync"
    payload: Payload


class SyncStreamRequest(BaseMessage):
    action: Literal["sync_stream"] = "sync_stream"
    payload: Payload


class EarlyReturnRequest(BaseMessage):
    action: Literal["early_return"] = "early_return"
    payload: Payload


class FailingStreamRequest(BaseMessage):
    action: Literal["failing_stream"] = "failing_stream"
    payload: Payload


class Response(BaseMessage):
    action: Literal["item"] = "item"
    payload: Payload


class Consumer(AsyncJsonWebsocketConsumer):
    should_send_completion = False

    def __init__(self) -> None:
        self.sent: list[BaseMessage] = []
        self.finalized: list[str] = []

    async def send_message(self, message: BaseMessage) -> None:
        self.sent.append(message)

    @ws_handler
    async def stream(self, message: Request) -> AsyncIterator[Response]:
        yield Response(payload=message.payload)
        yield Response(payload=Payload(value="second"))

    # Chanx types handlers as async; Pynect adapts synchronous callables.
    @ws_handler  # type: ignore
    def sync(self, message: SyncRequest) -> Response:
        return Response(payload=message.payload)

    # Chanx types handlers as async; Pynect adapts synchronous callables.
    @ws_handler  # type: ignore
    def sync_stream(self, message: SyncStreamRequest) -> Iterator[Response]:
        yield Response(payload=message.payload)
        yield Response(payload=Payload(value="second"))

    @ws_handler
    async def early_return(self, message: EarlyReturnRequest) -> AsyncIterator[Response]:
        try:
            yield Response(payload=message.payload)
            return
        finally:
            self.finalized.append("early_return")

    @ws_handler
    async def failing_stream(self, message: FailingStreamRequest) -> AsyncIterator[Response]:
        try:
            yield Response(payload=message.payload)
            raise RuntimeError("iteration failed")
        finally:
            self.finalized.append("failing_stream")


def test_iterator_handler_sends_items_and_framework_completion() -> None:
    consumer = Consumer()

    asyncio.run(consumer.stream(Request(payload=Payload(value="first"))))

    assert [message.action for message in consumer.sent] == ["item", "item", "complete"]
    assert isinstance(consumer.sent[-1], CompleteMessage)
    handler_info = Consumer.stream._ws_handler_info  # type: ignore[attr-defined]
    assert handler_info["output_type"] is Response
    assert handler_info["x_pynect_stream"] is True


def test_sync_handler_returns_through_chanx_dispatch() -> None:
    consumer = Consumer()

    asyncio.run(consumer.receive_message(SyncRequest(payload=Payload(value="sync"))))

    assert [message.payload.value for message in consumer.sent] == ["sync"]


def test_sync_iterator_handler_sends_items_and_completion() -> None:
    consumer = Consumer()

    asyncio.run(consumer.sync_stream(SyncStreamRequest(payload=Payload(value="first"))))

    assert [message.action for message in consumer.sent] == ["item", "item", "complete"]
    handler_info = Consumer.sync_stream._ws_handler_info  # type: ignore[attr-defined]
    assert handler_info["output_type"] is Response
    assert handler_info["x_pynect_stream"] is True


def test_early_return_closes_iterator_and_sends_completion() -> None:
    consumer = Consumer()

    asyncio.run(consumer.early_return(EarlyReturnRequest(payload=Payload(value="first"))))

    assert [message.action for message in consumer.sent] == ["item", "complete"]
    assert consumer.finalized == ["early_return"]


def test_iteration_error_closes_iterator_and_sends_chanx_error() -> None:
    consumer = Consumer()

    asyncio.run(consumer.receive_message(FailingStreamRequest(payload=Payload(value="first"))))

    assert [message.action for message in consumer.sent] == ["item", "error"]
    assert isinstance(consumer.sent[-1], ErrorMessage)
    assert consumer.finalized == ["failing_stream"]


def test_legacy_decorator_remains_compatible() -> None:
    with pytest.warns(DeprecationWarning, match="pynect_worker.ws_handler is deprecated"):

        @pynect_ws_handler
        async def legacy(consumer: Consumer, message: Request) -> AsyncIterator[Response]:
            yield Response(payload=message.payload)

    consumer = Consumer()
    asyncio.run(legacy(consumer, Request(payload=Payload(value="legacy"))))

    assert [message.action for message in consumer.sent] == ["item", "complete"]
