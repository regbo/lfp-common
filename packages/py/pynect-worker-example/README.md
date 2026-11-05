# Model catalog example

This is the smallest complete Pynect project. It is an installable uv workspace
member used for development and examples, but it is not published to PyPI.
[`server.py`](src/pynect_worker_example/server.py) owns the
Pydantic messages, Chanx route, validation, and implementation. Pynect exports
that app's AsyncAPI document and generates the TypeScript client in
`_generated/model-catalog`. The Python source shows both an immediate
`list_models` request/response and a delayed `list_models_stream` backed by an
async iterator. [`client.ts`](client.ts) calls both and consumes the streamed
replies with `for await`. Each server start builds a fresh catalog of readable
random model IDs with `coolname`.

The stream does not define an application-level completion message. Pynect
detects the `AsyncIterator[...]` return type, sends Chanx's built-in `complete`
frame when Python reaches the end of the function, and generates the
TypeScript async iterator that stops on that frame.

Run `uv sync` once from the repository root, then run these commands from
`packages/js/pynect`.

Generate or refresh the client:

```sh
bun run example:generate
```

Call either operation from the example CLI. Each invocation directly starts
its own Python process, captures the early PID record, communicates over
length-framed stdio, and tears the worker down when the command finishes:

```sh
bun run example:cli -- list-models
bun run example:cli -- list-models-stream --provider openai
```

Add `--json` to either command for machine-readable stdout. `list-models`
returns one JSON array. `list-models-stream` writes newline-delimited JSON (one
model per yield), so each item appears as soon as Python sends it. Python stderr
and ordinary stdout are routed to stderr in JSON mode so CLI stdout stays safe
to pipe or parse.

Call both operations through the same invocation-owned Python process:

```sh
bun run example:local
```

For the remote path, start the same app over WebSocket:

```sh
bun run example:serve
```

Then call it from another terminal:

```sh
bun run example:remote
```

Set `CHANX_BASE_URL` to point the remote client at another server. The generated
types and [`client.ts`](client.ts) are shared; only the Chanx client options
change between [`local.ts`](local.ts) and [`remote.ts`](remote.ts).
