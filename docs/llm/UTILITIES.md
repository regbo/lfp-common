# Utility map

- `scripts/python.js`: shared build-time and runtime policy boundary; creates the Pyfig 0.7 `Python` runtime used for every Python and uv operation and requires an embeddable, GIL-enabled environment.
- `scripts/ensure-native.js`: loqkit-coordinated native builder invoked through the active JavaScript runtime when no addon can be loaded.
- `scripts/postinstall.js`: lifecycle entrypoint that finds the application through `INIT_CWD` and runs the same uv project sync when installed npm packages contribute Pynect manifests.
- `scripts/build-typescript.js`: clean TypeScript build entrypoint; removes only `dist` before invoking the repository compiler so deleted source files cannot leak into npm artifacts.
- `src/native/native-addon-loader.ts`: platform/Stable-ABI/glibc-aware prebuild loader, portable `libpython3` sidecar materializer, exact-Python local-addon loader, and lazy build boundary; relaunches `process.execPath`, never a hard-coded Node executable.
- `scripts/stage-prebuild.js`: rewrites release addons to the generic Python 3 Stable ABI library name and records platform, architecture, Python floor, N-API, and Linux glibc compatibility metadata.
- `scripts/smoke-prebuild.js`: hides the local build and runs the shared Python-boundary smoke test through the staged prebuild only.
- `scripts/docker-zero-python.sh`: clean Linux container proof for uv/Python bootstrap, native build, and shared-interpreter smoke coverage.
- `src/env/python.ts`: typed access to the shared Pyfig policy from compiled source.
- `src/config/project.ts`: canonical package.json/API manifest normalizer plus environment and CLI project policy resolver. Omitted schema versions select the current schema; precedence is explicit overrides, environment, root package.json, then defaults.
- `src/env/project-environment.ts`: transitive `pynect` manifest discovery, dependency aggregation, namespaced module registry, and direct Pyfig option construction. Pyfig and uv own resolution, content addressing, caching, and provisioning coordination.
- `python/type_inspector.py`: the single Python inspection source used by `pynect codegen`.
- `src/cli/codegen.ts`: Commander command, Pacwich project discovery, configuration precedence, selection policy, project setup, and declaration emission.
- `src/cli/sync.ts`: Commander surface for explicit Pyfig environment preparation.
- `src/utils/locking.ts`: the only TypeScript locking boundary, using loqkit's CommonJS-compatible export. Project and build operations use its default memory, worker-thread, and file layers; process-owned resources explicitly use its memory scope.
- `python/pynect_dispatcher.py`: runtime include/exclude policy, optional Pydantic 1/2 validation, JSON-compatible return normalization, and persistent asyncio loop.
- `src/utils/logger.ts`: plain-text structured runtime logging.

Do not introduce a second declaration generator. Extend the inspector and codegen command together.
Do not spawn Python or package installers directly from new Pynect code. Route them through `src/env/python.ts` so build and runtime ABI selection cannot diverge.
Do not add custom JavaScript locks or memo caches. Route keyed critical sections through `src/utils/locking.ts` and use loqkit's `memoize` for memoized getters.
