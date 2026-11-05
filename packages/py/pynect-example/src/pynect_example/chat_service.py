"""Prepare native chat dependencies and load the model when a client connects."""

import asyncio
from contextlib import suppress

from pynect_example.chat import load_chat_model, prepare_chat_runtime
from pynect_example.domain import ChatModelStatus

prepare_chat_runtime()

from pynect_example.service import ChatStatusEvent, DemoConsumer  # noqa: E402


class ChatConsumer(DemoConsumer):
    """Start connection-scoped model loading after Chanx authentication."""

    async def post_authentication(self) -> None:
        await super().post_authentication()
        loop = asyncio.get_running_loop()

        def report(status: ChatModelStatus) -> None:
            if getattr(self, "_closed", False):
                return
            sent = asyncio.run_coroutine_threadsafe(
                self.send_message(ChatStatusEvent(payload=status)),
                loop,
            )
            with suppress(Exception):
                sent.result()

        try:
            await asyncio.to_thread(load_chat_model, report)
        except Exception as error:
            report(ChatModelStatus(stage="error", message=f"SmolLM2 failed: {error}"))
            raise


app = ChatConsumer.as_asgi()

__all__ = ["app"]
