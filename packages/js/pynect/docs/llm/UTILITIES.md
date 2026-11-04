# Utility map

## TypeScript

- `src/config.ts`: the single project configuration loader. Direct options
  override `[tool.pynect]`, which overrides project-derived defaults.
- `src/codegen.ts`: exports AsyncAPI through Python and delegates TypeScript
  generation to `@chanx-js/codegen`.
- `src/python-runtime.ts`: the shared Pyfig/uv launcher for bundled Python
  adapter commands.
- `src/ipc.ts`: Chanx `socketFactory` adapter for Unix sockets and Windows
  named pipes.
- `src/pid-handshake.ts`: captures the Python PID sentinel before forwarding
  server stdout.
- `src/server.ts`: starts, reuses, and disposes local IPC servers.
- `src/utils/python-package.ts`: locates the bundled wheel or editable Python
  adapter during development.
- `example/`: runnable Python-owned model catalog with one generated Chanx
  client shared by local IPC and remote WebSocket entrypoints.

The Python schema and IPC runtime live independently in
`packages/py/pynect-worker`; the npm build bundles its wheel into `dist/py`.
