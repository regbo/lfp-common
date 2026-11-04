import asyncio
from collections.abc import AsyncIterator
from typing import Literal

from chanx.messages.base import BaseMessage
from chanx.messages.outgoing import CompleteMessage
from pydantic import BaseModel

from pynect_worker import ws_handler


class Payload(BaseModel):
    value: str


class Request(BaseMessage):
    action: Literal["stream"] = "stream"
    payload: Payload


class Response(BaseMessage):
    action: Literal["item"] = "item"
    payload: Payload


class Consumer:
    should_send_completion = False

    def __init__(self) -> None:
        self.sent: list[BaseMessage] = []

    async def send_message(self, message: BaseMessage) -> None:
        self.sent.append(message)

    @ws_handler
    async def stream(self, message: Request) -> AsyncIterator[Response]:
        yield Response(payload=message.payload)
        yield Response(payload=Payload(value="second"))


def test_iterator_handler_sends_items_and_framework_completion() -> None:
    consumer = Consumer()

    asyncio.run(consumer.stream(Request(payload=Payload(value="first"))))

    assert [message.action for message in consumer.sent] == ["item", "item", "complete"]
    assert isinstance(consumer.sent[-1], CompleteMessage)
    handler_info = Consumer.stream._ws_handler_info  # type: ignore[attr-defined]
    assert handler_info["output_type"] is Response
    assert handler_info["x_pynect_stream"] is True
