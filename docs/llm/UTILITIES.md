# Utility map

- `src/config.ts`: the single normalizer for public `CreateVenvOptions`; resolves
  paths, validates timeouts and raw uv arguments, and constructs Pyfig options.
- `src/protocol.ts`: typed message kinds, RPC operations, and wire-value tags used
  by every TypeScript protocol caller. Keep its values aligned with the enums in
  `python/pynect_worker.py`.
- `src/rpc-client.ts`: framed MessagePack transport, handshake validation, callback
  dispatch, value encoding, and remote-reference lifetime management.
- `src/python-object.ts`: the proxy surface for Python objects, calls, properties,
  keyword arguments, async iteration, and explicit release.
- `src/python-venv.ts`: lazy Pyfig/uv environment startup, worker process lifecycle,
  module aliases, and automatic process shutdown.
- `src/transport/local-ipc.ts`: one-client Unix socket or Windows named-pipe server.
- `src/utils/timing.ts`: shared promise timeout behavior for connection and RPC
  handshakes.
- `python/pynect_worker.py`: the Python side of the typed protocol, object registry,
  callback re-entry, optional Pydantic validation, and serialization.
- `python/pynect_codegen.py`: the sole binding generator and developer setup entry
  point. It owns typed config precedence, Python inspection, TypeScript rendering,
  VS Code Run on Save setup, and the optional Hatchling build hook.
- `scripts/build-typescript.js`: clean TypeScript build entrypoint.
- `scripts/release.ts`: verified tag-driven npm release entrypoint.

Do not add raw RPC operation strings outside the protocol modules. Extend both
protocol definitions and cover the cross-language path in `tests/bridge.test.ts`.

Do not add another binding generator or editor-specific generator command. Route
generation, setup, and build hooks through `python/pynect_codegen.py` so all three
use the same settings and renderer.
