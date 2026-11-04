# pynect-worker

`pynect-worker` is Pynect's Python package. It exports Chanx AsyncAPI schemas,
adds iterator-aware server handlers, and runs Python-owned Chanx applications
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

Import `ws_handler` from `pynect_worker` and annotate an iterator return type.
Pynect forwards each item and emits Chanx's protocol-level `complete` frame
when the iterator exits normally.

```py
from collections.abc import AsyncIterator
from pynect_worker import ws_handler

@ws_handler
async def watch(self, message: WatchRequest) -> AsyncIterator[WatchResponse]:
    yield WatchResponse(payload=message.payload)
```

MIT licensed.
