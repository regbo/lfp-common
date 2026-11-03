# lfp-js

The shared Bun monorepo for LFP Connect JavaScript and TypeScript libraries.

| Package | Purpose |
| --- | --- |
| [`loqkit`](packages/loqkit) | Typed memoization and layered locks. |
| [`optionkit`](packages/optionkit) | Zod-backed CLI configuration. |
| [`pyfig`](packages/pyfig) | uv bootstrap and Python execution. |
| [`pynect`](packages/pynect) | Lazy Python environments and object proxies. |

All packages use the version declared in `.projenrc.ts`, external versions come from its Bun catalog, and sibling packages use `workspace:*`.

Run `bun run projen` after changing project configuration and `bun run verify` for the full workspace check.