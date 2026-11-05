# Pynect example

This workspace is a small application, not a protocol-only fixture. Python owns
three operations on one Chanx channel:

- `get_weather` returns one simulated weather snapshot.
- `watch_weather` yields a finite stream of weather-change events from an async
  generator.
- `chat` runs SmolLM2 locally in Python and keeps the connection-local
  conversation transcript there. Each prompt and transcript crosses the Pynect
  channel, so the generated client remains the state boundary.

The weather is deterministic synthetic data, so the example needs no API key or
network access. Replace the functions in
[`domain.py`](src/pynect_example/domain.py) with real application logic while
keeping the transport contract in
[`service.py`](src/pynect_example/service.py).

The service itself does not import FastAPI or any HTTP server. Owned stdio starts
`pynect_example.service:app` directly. The separate
[`server.py`](src/pynect_example/server.py) is the thin HTTP adapter: it adds a
homepage, `/health`, AsyncAPI documentation, and the `/ws/demo` WebSocket route.
Pynect generates the shared TypeScript client in `_generated/pynect-example`.

The stdio worker starts Python through Pyfig's `uv run` path, so uv prepares and
syncs the project environment before Python starts. Run the Bun workspace install
once, then use these commands from `packages/js/pynect`.

Generate or refresh the client:

```sh
bun run example:generate
```

## Owned stdio CLI

Each CLI invocation owns one Python process, communicates through
length-framed stdio records, and tears the process down on completion:

```sh
bun run example:cli -- weather --location "Boston, MA"
bun run example:cli -- watch-weather --location "Boston, MA" --updates 5
bun run example:cli -- chat --name Bun
```

Add `--json` for machine-readable output. `weather` emits one snapshot and
one-shot chat emits the Python-owned transcript. `watch-weather` emits one
NDJSON record per yield, so consumers receive events as Python produces them.
For scripts, supply `--message` to make chat a single turn instead of an
interactive session:

```sh
bun run example:cli -- chat --name Bun --message "What can this service do?" --json
```

Clack is a regular dependency of this example. Python uses Transformers and
Optimum ONNX Runtime to load
`onnx-community/SmolLM2-135M-Instruct-ONNX-MHA` with q4 weights. Hugging Face's
runtime downloader fetches the tokenizer and model on the first chat and reuses
its local cache afterward. A chat connection starts model loading from
`post_authentication()` and receives typed loading, downloading, and ready
events. The CLI uses those Python events to update one status indicator before
showing the first prompt; generation runs off-loop.
An interactive session keeps one worker, model, transcript, and connection open
and exits with `/exit`, `/quit`, or Ctrl+C.

Run all three patterns over one invocation-owned connection:

```sh
bun run example:local
```

## Web server

Start the same service behind FastAPI and Uvicorn:

```sh
bun run example:serve
```

Open <http://127.0.0.1:7777> for the landing page,
<http://127.0.0.1:7777/health> for the health check, or
<http://127.0.0.1:7777/asyncapi> for generated API documentation. In another
terminal, exercise `/ws/demo` with the same generated client:

```sh
bun run example:remote
```

Set `CHANX_BASE_URL` to connect the remote example to another host. Only the
client options change between [`local.ts`](local.ts) and
[`remote.ts`](remote.ts); both use [`client.ts`](client.ts).
