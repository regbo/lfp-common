# Utility map

- `src/config.ts`: the single normalizer for public `CreateVenvOptions`; resolves
  paths, validates timeouts and raw uv arguments, and constructs Pyfig options.
- `src/cli.mts`: the Optionkit-backed `pynect` command tree. Keep CLI schema
  adaptation and lazy Fireargs loading centralized in Optionkit.
- `src/codegen.ts`: the Zod codegen contract, Node-side configuration loader,
  editor setup, and private JSON request client for the Python inspection engine.
- `src/protocol.ts`: typed message kinds, RPC operations, and wire-value tags used
  by every TypeScript protocol caller. Keep its values aligned with the enums in
  `scripts/pynect_worker.py`.
- `src/rpc-client.ts`: framed MessagePack transport, handshake validation, callback
  dispatch, value encoding, and remote-reference lifetime management.
- `src/python-object.ts`: the proxy surface for Python objects, calls, properties,
  keyword arguments, async iteration, and explicit release.
- `src/python-venv.ts`: lazy Pyfig/uv environment startup, worker process lifecycle,
  module aliases, and automatic process shutdown.
- `src/transport/local-ipc.ts`: one-client Unix socket or Windows named-pipe server.
- `src/utils/python-script.ts`: source-tree and bundled Python script resolution.
- `src/utils/timing.ts`: shared promise timeout behavior for connection and RPC
  handshakes.
- `scripts/pynect_worker.py`: the Python side of the typed protocol, object registry,
  callback re-entry, optional Pydantic validation, and serialization.
- `scripts/pynect_codegen.py`: private Python annotation inspection and TypeScript
  rendering engine. It accepts exactly one JSON request from `src/codegen.ts`.
- `scripts/build-typescript.js`: clean TypeScript build entrypoint.
- `scripts/release.ts`: verified tag-driven npm release entrypoint.

Do not add raw RPC operation strings outside the protocol modules. Extend both
protocol definitions and cover the cross-language path in `tests/bridge.test.ts`.

Keep codegen options, configuration, and setup in `src/codegen.ts`. Keep the
Python engine private and free of CLI/configuration dependencies.
