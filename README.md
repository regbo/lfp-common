# lfp-common

The shared Bun and uv monorepo for LFP Connect libraries.

| Package | Purpose |
| --- | --- |
| [`loqkit`](packages/loqkit) | Typed memoization and layered locks. |
| [`optionkit`](packages/optionkit) | Zod-backed CLI configuration. |
| [`pyfig`](packages/pyfig) | uv bootstrap and Python execution. |
| [`pynect`](packages/pynect) | Local and remote Python object proxies plus the `pynect-worker` Python distribution. |

All packages use the version declared in `.projenrc.ts`, external versions come from its Bun catalog, and sibling packages use `workspace:*`.
Every workspace publishes its generated `PACKAGE_NAME` and `PACKAGE_VERSION` constants from the `./metadata` subpath.

Run `bun run projen` after changing project configuration and `bun run verify` for the full workspace check.