# Pynect

Pynect keeps a Chanx API in Python, generates its TypeScript client, and lets the
same generated channels connect remotely over WebSocket or locally over a Unix
socket/Windows named pipe.

It deliberately does not proxy arbitrary Python objects. Chanx owns messages,
validation, routing, streaming, and client types.

## Install

```sh
bun add pynect @chanx-js/client
```

Python projects use Chanx directly:

```toml
[project]
name = "model-catalog"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = ["chanx[fast_channels]>=2.14,<3"]

[tool.pynect]
app = "server:app"
```

`app` is the only Pynect setting normally needed. It identifies the FastAPI or
Starlette ASGI application containing the Chanx routes. It defaults to
`server:app`.

The [`example`](example) directory contains a complete model-catalog project
with generated TypeScript plus local IPC and remote WebSocket clients.

## Write the API in Python

```py
from typing import Literal

from chanx.core.decorators import channel, ws_handler
from chanx.fast_channels.websocket import AsyncJsonWebsocketConsumer
from chanx.messages.base import BaseMessage
from fastapi import FastAPI
from pydantic import BaseModel


class GreetPayload(BaseModel):
    name: str


class GreetRequest(BaseMessage):
    action: Literal["greet"] = "greet"
    payload: GreetPayload


class GreetResponse(BaseMessage):
    action: Literal["greeted"] = "greeted"
    payload: str


@channel(name="greeter")
class Greeter(AsyncJsonWebsocketConsumer):
    @ws_handler
    async def greet(self, message: GreetRequest) -> GreetResponse:
        return GreetResponse(payload=f"Hello {message.payload.name}")


app = FastAPI(title="Greeter", version="1.0.0")
app.router.add_websocket_route("/ws/greeter", Greeter.as_asgi())
```

## Generate TypeScript

```sh
bunx pynect generate
```

By default this writes both the exported schema and Chanx modules to:

```text
_generated/model-catalog/
  asyncapi.json
  channels.ts
  index.ts
  schemas.ts
```

Set `out` under `[tool.pynect]` when the TypeScript project lives elsewhere:

```toml
[tool.pynect]
app = "server:app"
out = "../web/src/_generated/model-catalog"
```

Configuration precedence is command options, `[tool.pynect]`, then defaults.
Pynect uses Pyfig to resolve uv and Python, and runs schema export inside the
configured uv project. Optional `python`, `uv`, `debug`, `validation`, and
`format` fields are available for projects that need them.

## Remote connection

Generated modules are standard `@chanx-js/client` descriptors:

```ts
import { createClient } from '@chanx-js/client';
import { greeter } from './_generated/model-catalog/index.js';

const client = createClient({ baseUrl: 'wss://api.example.com' });
const connection = client.connect(greeter);
const response = await connection.request({
  action: 'greet',
  payload: { name: 'Ada' },
});
```

## Local IPC

For a local process, start the same ASGI app through Pynect and pass its client
options to Chanx:

```ts
import { createClient } from '@chanx-js/client';
import { ensureIpcServer } from 'pynect';
import { greeter } from './_generated/model-catalog/index.js';

await using server = await ensureIpcServer({ root: '../python' });
const client = createClient(server.clientOptions);
const connection = client.connect(greeter);
```

`ensureIpcServer()` reuses an existing project socket or starts one owned by the
returned resource. The launcher prints and captures the real Python PID before
forwarding the rest of stdout, so disposal terminates Python rather than merely
signaling the intermediate uv process.

Run a long-lived local server from the command line with:

```sh
bunx pynect serve
```

The default endpoint is `<temp>/model-catalog.sock` on macOS/Linux and
`\\.\pipe\model-catalog` on Windows. Override it with
`MODEL_CATALOG_IPC_PATH` or the `ipcPath` JavaScript option.

MIT licensed.
