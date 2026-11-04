# Utility map

## JavaScript

- `src/js/config.ts`: normalizes local `CreateVenvOptions`; its shared worker
  fields come from the generated Pydantic schema adapter.
- `src/js/cli.mts`: Optionkit-backed npm CLI for code generation.
- `src/js/codegen.ts`: Node-side codegen configuration, editor setup, and the
  private request client for Python inspection.
- `src/js/protocol.ts`: public protocol seam backed by generated constants.
- `src/js/rpc-client.ts`: transport-neutral handshake, calls, callbacks, value
  encoding, and remote-reference lifetime management.
- `src/js/python-object.ts`: proxy behavior for calls, properties, keyword
  arguments, async iteration, and explicit release.
- `src/js/python-worker.ts`: uv-backed local worker launcher. It installs the
  bundled wheel, or the editable package during development.
- `src/js/transport/local-ipc.ts`: private Unix socket or Windows named-pipe
  listener used only by local Venvs.
- `src/js/transport/websocket-rpc.ts`: browser-compatible binary WebSocket
  client; it never imports local IPC, uv, or Node process utilities.
- `src/js/generate-schema.ts`: Pydantic JSON Schema to TypeScript, Zod, and
  protocol generation with a CI check mode.
- `src/js/utils/python-package.ts`: resolves the packaged worker wheel or
  editable source distribution.

## Python

- `src/py/pynect_worker/models.py`: source of truth for shared configuration,
  protocol enums, defaults, and limits.
- `src/py/pynect_worker/connection.py`: abstract message connection plus local
  Unix socket and Windows named-pipe framing.
- `src/py/pynect_worker/framing.py`: shared length-prefixed MessagePack codec.
- `src/py/pynect_worker/bridge.py`: per-session object registry, callback
  re-entry, Pydantic validation, operations, and serialization.
- `src/py/pynect_worker/server.py`: direct multi-client WebSocket server with a
  shared executor, per-client bridge state, default-deny module exposure, and
  latched process shutdown.
- `src/py/pynect_worker/cli.py`: Cyclopts worker and server commands generated
  from Pydantic models.
- `src/py/pynect_worker/schema.py`: canonical JSON Schema emitter.
- `src/py/pynect_worker/codegen.py`: Python annotation inspection and TypeScript
  rendering engine. It accepts one JSON request from `src/js/codegen.ts`.

Do not add raw operation strings or option defaults outside the model and
generated protocol modules. Remote servers must keep `modules` default-deny;
WebSocket disconnects must never signal the shared Python process.
