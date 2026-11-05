# Utility map

## TypeScript

- `src/config.ts`: the single project configuration loader. Direct options
  override `[tool.pynect]`, which overrides project-derived defaults.
- `src/codegen.ts`: exports AsyncAPI through Python and delegates TypeScript
  generation to `@chanx-js/codegen`.
- `src/python-runtime.ts`: the shared Pyfig/uv launcher for bundled Python
  adapter commands.
- `src/stdio-protocol.ts`: random-marker, byte-length-delimited record codec,
  incremental stdout parser, pass-through backpressure, and serialized stdin
  writer.
- `src/worker.ts`: directly spawns, connects, and disposes one owned Python
  subprocess through a Chanx `WebSocketLike` adapter.
- `src/process-signals.ts`: forwards parent shutdown signals to the one owned
  child or its isolated POSIX process group.
- `src/utils/python-package.ts`: locates the bundled wheel or editable Python
  adapter during development.
- `../../py/pynect-worker-example/`: runnable Python-owned model catalog with
  one generated Chanx client shared by owned-worker and remote WebSocket
  entrypoints.

The Python schema and stdio runtime live independently in
`packages/py/pynect-worker`; the npm build bundles its wheel into `dist/py`.
