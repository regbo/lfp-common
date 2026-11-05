# lfp-common

The shared Bun and uv monorepo for LFP Connect libraries.

| Package | Purpose |
| --- | --- |
| [`loqkit`](packages/js/loqkit) | Typed memoization and layered locks. |
| [`optionkit`](packages/js/optionkit) | Zod-backed CLI configuration. |
| [`pyfig`](packages/js/pyfig) | uv bootstrap and Python execution. |
| [`pynect`](packages/js/pynect) | Python-owned Chanx APIs with generated TypeScript and an owned stdio worker. |
| [`pynect-worker`](packages/py/pynect-worker) | Python schema export, iterator handlers, and stdio runtime. |
| [`pynect-worker-example`](packages/py/pynect-worker-example) | Non-published model-catalog workspace member. |

All packages use the version declared in `.projenrc.ts`, external versions come from its Bun catalog, and sibling packages use `workspace:*`.
Every workspace publishes its generated `PACKAGE_NAME` and `PACKAGE_VERSION` constants from the `./metadata` subpath.

Run `uv sync` for the shared Python environment, `bun run projen` after changing project configuration, and `bun run verify` for the full workspace check.