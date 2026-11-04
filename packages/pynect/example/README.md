# Model catalog example

This is the smallest complete Pynect project. [`server.py`](server.py) owns the
Pydantic messages, Chanx route, validation, and implementation. Pynect exports
that app's AsyncAPI document and generates the TypeScript client in
`_generated/model-catalog`. The Python source shows both an immediate
`list_models` request/response and a delayed `list_models_stream` backed by an
async iterator. [`client.ts`](client.ts) calls both and consumes the streamed
replies with `for await`.

Run these commands from `packages/pynect`.

Generate or refresh the client:

```sh
bun run example:generate
```

Call either operation from the example CLI. It starts the local IPC server when
needed:

```sh
bun run example:cli -- list-models
bun run example:cli -- list-models-stream --provider openai
```

Call Python locally over a Unix socket or Windows named pipe:

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
