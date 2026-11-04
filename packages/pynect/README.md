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
dependencies = [
  "chanx[fast_channels]>=2.14,<3",
  "pynect-worker>=0.8,<1",
]

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
from collections.abc import AsyncIterator
from typing import Literal

from chanx.core.decorators import channel
from chanx.fast_channels.websocket import AsyncJsonWebsocketConsumer
from chanx.messages.base import BaseMessage
from fastapi import FastAPI
from pydantic import BaseModel
from pynect_worker import ws_handler


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

Annotate a handler with `AsyncIterator[Response]` and yield messages to make it
a stream. Pynect forwards each yield, emits Chanx's protocol-level `complete`
frame when the iterator exits normally, and generates a TypeScript async
iterator. Application messages do not need a completion model or flag:

```py
@ws_handler
async def greet_many(
    self, message: GreetRequest
) -> AsyncIterator[GreetResponse]:
    for name in message.payload.name.split(","):
        yield GreetResponse(payload=f"Hello {name.strip()}")
```

```ts
import { greetMany } from './_generated/model-catalog/index.js';

for await (const response of greetMany(clientOptions, { name: 'Ada, Grace' })) {
  console.log(response.payload);
}
```

Generated streams use Chanx request refs for correlation. Concurrent stream
calls get independent logical connections while sharing one physical socket;
their yielded messages, errors, and completion frames cannot end one another's
iterators. The business payload stays unchanged.

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
  streams.ts
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
import { startIpcServer } from 'pynect';
import { greeter } from './_generated/model-catalog/index.js';

await using server = await startIpcServer({ root: '../python' });
const client = createClient(server.clientOptions);
const connection = client.connect(greeter);
```

`startIpcServer()` always starts a worker owned by the current process. The
launcher captures the real Python PID, and the worker watches its parent PID,
so it exits if the parent disappears. Use `await using` for scoped cleanup or
call `await server.close()` explicitly. Both are safe to call more than once.

For a long-lived command, wait without adding signal handlers:

```ts
const server = await startIpcServer({ root: '../python' });
await server.wait();
```

The parent process keeps its normal signal behavior; Python shuts down when
that parent exits. `ensureIpcServer()` remains available only when deliberately
reusing an existing endpoint is desired.

Run a long-lived local server from the command line with:

```sh
bunx pynect serve
```

The default endpoint is `<temp>/model-catalog.sock` on macOS/Linux and
`\\.\pipe\model-catalog` on Windows. Override it with
`MODEL_CATALOG_IPC_PATH` or the `ipcPath` JavaScript option.

MIT licensed.
