# Model catalog example

This is the smallest complete Pynect project. [`server.py`](server.py) owns the
Pydantic messages, Chanx route, validation, and implementation. Pynect exports
that app's AsyncAPI document and generates the TypeScript client in
`_generated/model-catalog`. The Python source streams matching models from an
async iterator with a short random delay, and [`client.ts`](client.ts) consumes
the typed replies with `for await`.

Run these commands from `packages/pynect`.

Generate or refresh the client:

```sh
bun run example:generate
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
