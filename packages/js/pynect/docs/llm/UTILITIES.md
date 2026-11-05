# Utility map

## TypeScript

- `src/config.ts`: the single project configuration loader. Direct options
  override `[tool.pynect]`, which overrides project-derived defaults.
- `src/codegen.ts`: exports AsyncAPI through Python, delegates TypeScript
  generation to `@chanx-js/codegen`, and derives Zod-mode types from the
  generated validators.
- `src/codegen-stream.ts`: marks iterator operations in generated Chanx
  channels and exports Pynect's streaming client support.
- `src/python-runtime.ts`: the shared Pyfig/uv launcher for bundled Python
  adapter commands.
- `src/errors.ts`: normalizes unknown thrown values at internal boundaries.
- `src/promise.ts`: applies the shared unref'ed promise timeout used by the
  worker and benchmark harnesses.
- `src/stdio-protocol.ts`: random-marker, byte-length-delimited record codec,
  incremental stdout parser, pass-through backpressure, and serialized stdin
  writer.
- `src/worker.ts`: directly spawns, connects, and disposes one owned Python
  subprocess through a Chanx `WebSocketLike` adapter.
- `src/process-signals.ts`: forwards parent shutdown signals to the one owned
  child or its isolated POSIX process group.
- `src/python-package.ts`: locates the bundled wheel or editable Python
  adapter during development.
- `../../py/pynect-example/`: runnable weather, event-stream, and stateful-chat
  service with one generated Chanx client shared by owned-worker and remote
  WebSocket entrypoints; its CLI calls the public `startWorker()` API and
  always uses invocation-owned stdio IPC.

The Python schema and stdio runtime live independently in
`packages/py/pynect`; the npm build bundles its wheel into `dist/py`.
