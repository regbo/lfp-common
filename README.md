# lfp-common

The shared Bun and uv monorepo for LFP Connect libraries.

| Package | Purpose |
| --- | --- |
| [`loqkit`](packages/js/loqkit) | Typed memoization and layered memory, worker-thread, and file locks for JavaScript runtimes. |
| [`optionkit`](packages/js/optionkit) | Turn Zod configuration schemas into zero-setup CLI options. |
| [`pyfig`](packages/js/pyfig) | Bootstrap uv and delegate Python execution to it. |
| [`pynect`](packages/js/pynect) (npm) | Generate Chanx clients from Python and run them through an owned stdio worker. |
| [`pynect`](packages/py/pynect) (PyPI) | Chanx schema export and owned stdio adapter for Pynect. |
| [`pynect-example`](packages/py/pynect-example) | Python-owned Chanx model catalog consumed by the Pynect TypeScript example. |

All packages use the version declared in `.projenrc.ts`, external versions come from its Bun catalog, and sibling packages use `workspace:*`.
Every workspace publishes its generated `PACKAGE_NAME` and `PACKAGE_VERSION` constants from the `./metadata` subpath.

Run `uv sync` for the shared Python environment, `bun run projen` after changing project configuration, and `bun run verify` for the full workspace check.