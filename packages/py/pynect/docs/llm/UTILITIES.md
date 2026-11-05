# Utility map

- `src/pynect/websocket.py`: adapts iterator-annotated Chanx handlers
  before Chanx registers a consumer class.
- `src/pynect/handlers.py`: forwards yielded messages, records stream
  operations for schema export, and retains the deprecated decorator adapter.
- `src/pynect/schema.py`: exports Chanx AsyncAPI without starting an HTTP
  listener and marks iterator operations with `x-pynect-stream`.
- `src/pynect/worker/protocol.py`: validates marker-and-length records
  and serializes complete writes through one lock.
- `src/pynect/worker/stdio.py`: adapts the owning process's stdin and
  stdout to one ASGI WebSocket connection and deterministic shutdown.
- `src/pynect/_app.py`: imports a configured `module:object` application.

Keep application messages, handlers, validation, and routes in the consumer's
Chanx app. Pynect extends Chanx's schema and transport model; it does not define
a parallel RPC protocol.
