# Utility map

- `scripts/pyfig.js`: shared build-time and runtime policy adapter; creates the scoped Pyfig 0.4 client used for every Python and uv operation and requires an embeddable, GIL-enabled application environment.
- `scripts/ensure-native.js`: loqkit-coordinated native builder invoked through the active JavaScript runtime when no addon can be loaded.
- `scripts/postinstall.js`: lifecycle entrypoint that finds the application through `INIT_CWD` and runs the same uv project sync when installed npm packages contribute Pynect manifests.
- `scripts/build-typescript.js`: clean TypeScript build entrypoint; removes only `dist` before invoking the repository compiler so deleted source files cannot leak into npm artifacts.
- `src/native/native-addon-loader.ts`: platform/Python/glibc-aware prebuild loader, portable `libpython` sidecar materializer, exact-Python local-addon loader, and lazy build boundary; relaunches `process.execPath`, never a hard-coded Node executable.
- `scripts/stage-prebuild.js`: stages a release addon with platform, architecture, Python-minor, N-API, and Linux glibc compatibility metadata.
- `scripts/smoke-prebuild.js`: hides the local build and runs the shared Python-boundary smoke test through the staged prebuild only.
- `scripts/python-provisioner.js`: compatibility wrapper around `scripts/pyfig.js`.
- `scripts/docker-zero-python.sh`: clean Linux container proof for uv/Python bootstrap, native build, and shared-interpreter smoke coverage.
- `src/env/pyfig-adapter.ts`: typed access to the same adapter from compiled CommonJS source.
- `src/config/project.ts`: canonical JSON-pyproject package.json/API normalizer plus environment and CLI project policy resolver. Omitted schema versions select the current schema; precedence is explicit overrides, environment, root package.json, then defaults.
- `src/env/project-environment.ts`: transitive `pynect` manifest discovery, generated non-package uv project (normally beside the installed Pynect package at `node_modules/.pynect`, with per-application isolation for hoisted installs), namespaced module registry, loqkit-coordinated `uv sync`, and runtime environment fingerprint validation. uv owns package resolution and lock validation.
- `src/env/python-detector.ts`: legacy discovery facade constrained to the Pyfig-selected application environment; it never probes a host interpreter directly.
- `src/env/python-provisioner.ts`: compatibility wrapper around the centralized Pyfig selection.
- `src/env/venv-manager.ts`: compatibility facade that delegates environment and package operations to Pyfig.
- `src/env/package-installer.ts`: package inspection and installation routed through Pyfig's uv-backed Python and package runners.
- `src/env/executables.ts`: safe executable lookup, Python module validation, and package-spec validation.
- `python/type_inspector.py`: the single Python inspection source used by `pynect codegen`.
- `src/cli/codegen.ts`: Commander command, Pacwich project discovery, configuration precedence, selection policy, project setup, and declaration emission.
- `src/cli/sync.ts`: Commander surface for the shared project configuration and locked environment synchronization.
- `src/utils/locking.ts`: the only TypeScript locking boundary, using loqkit's CommonJS-compatible export. Project and build operations use its default memory, worker-thread, and file layers; process-owned resources explicitly use its memory scope.
- `python/pynect_dispatcher.py`: runtime include/exclude policy, optional Pydantic 1/2 validation, JSON-compatible return normalization, and persistent asyncio loop.
- `src/utils/logger.ts`: plain-text structured runtime logging.

Do not introduce a second declaration generator. Extend the inspector and codegen command together.
Do not spawn Python or package installers directly from new Pynect code. Route them through `src/env/pyfig-adapter.ts` so build and runtime ABI selection cannot diverge.
Do not add custom JavaScript locks or memo caches. Route keyed critical sections through `src/utils/locking.ts` and use loqkit's `memoize` for memoized getters.
