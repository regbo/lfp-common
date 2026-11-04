# pynect-worker

`pynect-worker` is Pynect's Python package. It exports Chanx AsyncAPI schemas,
adds an iterator-aware server consumer, and runs Python-owned Chanx applications
over Pynect's local IPC transport.

## Install

```sh
uv add pynect-worker
```

Configure the ASGI application in the owning Python project:

```toml
[tool.pynect]
app = "server:app"
```

## Server iterators

Subclass Pynect's consumer, use Chanx's standard `ws_handler`, and annotate an
iterator return type. Pynect forwards each item and emits Chanx's protocol-level
`complete` frame when the iterator exits normally.

```py
from collections.abc import AsyncIterator
from chanx.core.decorators import ws_handler
from pynect_worker import AsyncJsonWebsocketConsumer

class CatalogConsumer(AsyncJsonWebsocketConsumer):
    @ws_handler
    async def watch(self, message: WatchRequest) -> AsyncIterator[WatchResponse]:
        yield WatchResponse(payload=message.payload)
```

`pynect_worker.ws_handler` remains available for compatibility but is
deprecated.

The Pynect consumer also accepts synchronous handlers and synchronous
`Iterator[Response]` streams. Async handlers continue to use Chanx unchanged.
Chanx's annotations currently type handlers as async-only, so place a portable
ignore on synchronous decorator applications:

```py
# Chanx types handlers as async; Pynect adapts synchronous callables.
@ws_handler  # type: ignore
def watch_sync(self, message: WatchRequest) -> Iterator[WatchResponse]:
    yield WatchResponse(payload=message.payload)
```

Pynect closes server iterators deterministically after normal completion,
early return, iteration failure, send failure, or handler cancellation. Normal
completion emits `complete`; failures remain Chanx handler errors.

MIT licensed.
