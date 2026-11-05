# Pynect

Pynect keeps a Chanx API in Python, generates its TypeScript client, and lets the
same generated channels connect remotely over WebSocket or locally through an
owned Python subprocess's stdin and stdout.

It deliberately does not proxy arbitrary Python objects. Chanx owns messages,
validation, routing, streaming, and client types.

## Install

```sh
bun add pynect @chanx-js/client
```

Python projects use Chanx directly:

```toml
[project]
name = "weather-service"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
  "chanx[fast_channels]>=2.13.0,<3",
  "pynect>=0.8,<1",
]

[tool.pynect]
app = "server:app"
```

`app` is the only Pynect setting normally needed. It identifies the FastAPI or
Starlette ASGI application containing the Chanx routes. It defaults to
`server:app`.

The [`pynect-example`](../../py/pynect-example) workspace contains
a complete weather, event-stream, and stateful-chat project with generated
TypeScript plus owned-worker and remote WebSocket clients.

## Write the API in Python

```py
from collections.abc import AsyncIterator
from typing import Literal

from chanx.core.decorators import channel, ws_handler
from chanx.messages.base import BaseMessage
from fastapi import FastAPI
from pydantic import BaseModel
from pynect import AsyncJsonWebsocketConsumer


class GreetPayload(BaseModel):
    name: str


class GreetRequest(BaseMessage):
    action: Literal["greet"] = "greet"
    payload: GreetPayload


class GreetManyRequest(BaseMessage):
    action: Literal["greet_many"] = "greet_many"
    payload: GreetPayload


class GreetResponse(BaseMessage):
    action: Literal["greeted"] = "greeted"
    payload: str


@channel(name="greeter")
class Greeter(AsyncJsonWebsocketConsumer):
    @ws_handler
    async def greet(self, message: GreetRequest) -> GreetResponse:
        return GreetResponse(payload=f"Hello {message.payload.name}")

    @ws_handler
    async def greet_many(
        self, message: GreetManyRequest
    ) -> AsyncIterator[GreetResponse]:
        for name in message.payload.name.split(","):
            yield GreetResponse(payload=f"Hello {name.strip()}")


app = FastAPI(title="Greeter", version="1.0.0")
app.router.add_websocket_route("/ws/greeter", Greeter.as_asgi())
```

Annotate a handler with `Iterator[Response]` or `AsyncIterator[Response]` and
yield messages to make it a stream. Pynect supports synchronous handlers too,
forwards each yield, emits Chanx's protocol-level `complete` frame when the
iterator exits normally, and types the corresponding request as an async
iterator. Application messages do not need a completion model or flag:

Chanx currently types handlers as async-only. On synchronous handlers, use
`@ws_handler  # type: ignore`; Pynect adapts them at runtime.

Returning early completes the stream normally. Iterator failures close server
iterator resources and surface as `ChanxRequestError`; ending iteration on the
client releases its listeners and logical shared connection. Chanx does not
currently expose per-request cancellation, so a client-side `break` cannot
remotely interrupt a server handler that is still producing values.

```ts
import { createPynectClient, greeter } from './_generated/weather-service/index.js';

const connection = createPynectClient(clientOptions).connect(greeter);
const result = await connection.request({
  action: 'greet_many',
  payload: { name: 'Ada, Grace' },
});

for await (const response of result) {
  console.log(response.payload);
}
```

Pynect records iterator actions on the generated channel descriptor. Its
generated `createPynectClient()` uses that metadata so TypeScript infers normal
actions as `Promise<Response>` and iterator actions as
`AsyncIterable<Response>` through the same `connection.request()` method. The
request needs only its action and payload. Concurrent streams use Chanx request
refs for correlation and share one physical socket.

Generated indexes re-export both `createPynectClient` and its
`PynectClientOptions` type, so browser and worker wrappers share the same public
option shape without importing Chanx directly.

## Generate TypeScript

```sh
bunx pynect generate
```

By default this writes both the exported schema and Chanx modules to:

```text
_generated/weather-service/
  asyncapi.json
  channels.ts
  index.ts
  schemas.ts
```

Set `out` under `[tool.pynect]` when the TypeScript project lives elsewhere:

```toml
[tool.pynect]
app = "server:app"
out = "../web/src/_generated/weather-service"
```

Configuration precedence is command options, `[tool.pynect]`, then defaults.
Pynect uses Pyfig to resolve uv and Python, and runs schema export inside the
configured uv project. `python` accepts either an exact executable path or a
table of Pyfig options; `cwd` is omitted because Pynect supplies `root` as the
single project directory. Pyfig's `uv`, Python request, environment, and debug
options live inside that table instead of being repeated as Pynect options:

```toml
[tool.pynect]
python = { python = ">=3.12", uv = ">=0.10,<1", debug = true }
validation = "zod"
format = true
```

## Remote connection

Generated modules are standard `@chanx-js/client` descriptors:

```ts
import { createPynectClient, greeter } from './_generated/weather-service/index.js';

const client = createPynectClient({ baseUrl: 'wss://api.example.com' });
const connection = client.connect(greeter);
const response = await connection.request({
  action: 'greet',
  payload: { name: 'Ada' },
});
```

## Owned local worker

For local calls, start the same ASGI app and pass the worker's client options to
Chanx. Pass Pyfig options for normal runtime discovery:

```ts
import { startWorker } from 'pynect';
import { createPynectClient, greeter } from './_generated/weather-service/index.js';

await using worker = await startWorker({
  root: '../python',
});
await worker.ready;
const client = createPynectClient(worker.clientOptions);
const connection = client.connect(greeter);
```

`startWorker()` always starts one Python process owned by the current Bun/Node
process. Omitting `python` uses Pyfig's defaults. A string value is an exact
executable path and bypasses Pyfig resolution, which is useful for tests and
benchmarks. An object is passed to Pyfig, with `root` supplied as its working
directory. The worker never listens on an endpoint, exposes a reusable daemon,
or allows another process to connect. Use `await using` for scoped cleanup or
call `await worker.close()` explicitly; concurrent close calls share the same
shutdown operation.

stdin carries random-marker, byte-length-delimited protocol records. stdout
multiplexes the same records with byte-exact ordinary Python output, and stderr
is forwarded immediately. Chanx frames remain opaque strings inside the
transport. The first record reports the real Python PID before Pynect or the
configured app is imported. `await worker.ready` waits for the configured app
to finish importing without delaying that early PID result.

For a long-lived command, wait for the worker:

```ts
const worker = await startWorker(); // Current directory is the Python project.
await worker.wait();
```

Override Pyfig only when the project needs a specific runtime request:

```ts
const worker = await startWorker({
  root: '../python',
  python: { python: '3.12', uv: '>=0.10,<1' },
});
```

Pynect forwards `SIGINT`, `SIGTERM`, `SIGHUP`, and the platform shutdown signal
(`SIGQUIT` on macOS/Linux or `SIGBREAK` on Windows) to the owned process. On
macOS/Linux, the worker starts in an isolated process group. On Windows, the
console delivers Ctrl+C or Ctrl+Break directly. A custom parent signal handler
remains authoritative.

MIT licensed.
