# Utility map

## TypeScript

- `src/js/config.ts`: the single project configuration loader. Direct options
  override `[tool.pynect]`, which overrides project-derived defaults.
- `src/js/codegen.ts`: exports AsyncAPI through Python and delegates TypeScript
  generation to `@chanx-js/codegen`.
- `src/js/python-runtime.ts`: the shared Pyfig/uv launcher for bundled Python
  adapter commands.
- `src/js/ipc.ts`: Chanx `socketFactory` adapter for Unix sockets and Windows
  named pipes.
- `src/js/pid-handshake.ts`: captures the Python PID sentinel before forwarding
  server stdout.
- `src/js/server.ts`: starts, reuses, and disposes local IPC servers.
- `src/js/utils/python-package.ts`: locates the bundled wheel or editable Python
  adapter during development.
- `example/`: runnable Python-owned model catalog with one generated Chanx
  client shared by local IPC and remote WebSocket entrypoints.

## Python

- `src/py/pynect_worker/_app.py`: imports a configured `module:object` app.
- `src/py/pynect_worker/schema.py`: exports Chanx AsyncAPI without starting an
  HTTP listener.
- `src/py/pynect_worker/ipc.py`: adapts newline-delimited local streams to ASGI
  WebSocket connections.

Keep application messages, handlers, validation, and routes in the consumer's
Python Chanx app. Do not reintroduce a parallel RPC/object model in Pynect.
