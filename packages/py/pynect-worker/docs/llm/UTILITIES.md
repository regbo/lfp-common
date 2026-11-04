# Utility map

- `src/pynect_worker/websocket.py`: adapts iterator-annotated Chanx handlers
  before Chanx registers a consumer class.
- `src/pynect_worker/handlers.py`: forwards yielded messages, records stream
  operations for schema export, and retains the deprecated decorator adapter.
- `src/pynect_worker/schema.py`: exports Chanx AsyncAPI without starting an HTTP
  listener and marks iterator operations with `x-pynect-stream`.
- `src/pynect_worker/ipc.py`: adapts newline-delimited local streams to ASGI
  WebSocket connections.
- `src/pynect_worker/_app.py`: imports a configured `module:object` application.

Keep application messages, handlers, validation, and routes in the consumer's
Chanx app. Pynect extends Chanx's schema and transport model; it does not define
a parallel RPC protocol.
