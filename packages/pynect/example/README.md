# Model catalog example

This is the smallest complete Pynect project. [`server.py`](server.py) owns the
Pydantic messages, Chanx route, validation, and implementation. Pynect exports
that app's AsyncAPI document and generates the TypeScript client in
`_generated/model-catalog`. The Python source shows both an immediate
`list_models` request/response and a delayed `list_models_stream` backed by an
async iterator. [`client.ts`](client.ts) calls both and consumes the streamed
replies with `for await`. Each server start builds a fresh catalog of readable
random model IDs with `coolname`.

Run these commands from `packages/pynect`.

Generate or refresh the client:

```sh
bun run example:generate
```

Call either operation from the example CLI. Each invocation starts its own
Python IPC server on a parent-PID-specific endpoint, captures the Python PID
handshake, and tears the server down when the command finishes. The worker also
watches the parent PID so it exits if the parent process is terminated:

```sh
bun run example:cli -- list-models
bun run example:cli -- list-models-stream --provider openai
```

Add `--json` to either command for machine-readable stdout. `list-models`
returns one JSON array. `list-models-stream` writes newline-delimited JSON (one
model per yield), so each item appears as soon as Python sends it. IPC startup
logs are routed to stderr in JSON mode so stdout stays safe to pipe or parse.

Call both operations locally over the same invocation-scoped Unix socket or
Windows named pipe:

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
