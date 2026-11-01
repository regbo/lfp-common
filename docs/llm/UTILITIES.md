# Utility map

- `scripts/pyfig.js`: shared build-time and runtime policy adapter; creates the scoped Pyfig client used for every Python, pip, and uv operation and requires an embeddable, GIL-enabled repository `.venv`.
- `scripts/ensure-native.js`: loqkit-coordinated native builder invoked through the active JavaScript runtime when no addon can be loaded.
- `scripts/postinstall.js`: lifecycle entrypoint that finds the application through `INIT_CWD` and runs the same uv project sync when installed npm packages contribute Pynect manifests.
- `scripts/build-typescript.js`: clean TypeScript build entrypoint; removes only `dist` before invoking the repository compiler so deleted source files cannot leak into npm artifacts.
- `src/native/NativeAddonLoader.ts`: exact-Python local-addon loader and lazy build boundary; validates `build/pynect-python.json` and relaunches `process.execPath`, never a hard-coded Node executable.
- `scripts/python-provisioner.js`: compatibility wrapper around `scripts/pyfig.js`.
- `scripts/docker-zero-python.sh`: clean Linux container proof for uv/Python bootstrap, native build, and shared-interpreter smoke coverage.
- `src/env/PyfigAdapter.ts`: typed access to the same adapter from compiled CommonJS source.
- `src/config/project.ts`: canonical package.json, environment, API, and CLI project policy resolver. Precedence is explicit overrides, environment, root package.json, then defaults.
- `src/env/ProjectEnvironment.ts`: transitive `pynect` manifest discovery, generated non-package uv project, namespaced module registry, loqkit-coordinated `uv sync`, and runtime environment fingerprint validation. uv owns package resolution and lock validation.
- `src/env/PythonDetector.ts`: legacy discovery facade constrained to the Pyfig-selected root `.venv`; it never probes a host interpreter directly.
- `src/env/PythonProvisioner.ts`: compatibility wrapper around the centralized Pyfig selection.
- `src/env/VenvManager.ts`: compatibility facade that delegates root `.venv` and package operations to Pyfig.
- `src/env/PackageInstaller.ts`: package inspection and installation routed through Pyfig Python/pip runners.
- `src/env/executables.ts`: safe executable lookup, Python module validation, and package-spec validation.
- `python/type_inspector.py`: the single Python inspection source used by `pynect codegen`.
- `src/cli/codegen.ts`: Commander command, Pacwich project discovery, configuration precedence, selection policy, project setup, and declaration emission.
- `src/cli/sync.ts`: Commander surface for the shared project configuration and locked environment synchronization.
- `src/utils/Locking.ts`: the only TypeScript locking boundary, using loqkit's CommonJS-compatible export. Project and build operations use its default memory, worker-thread, and file layers; process-owned resources explicitly use its memory scope.
- `python/pynect_dispatcher.py`: runtime include/exclude policy, optional Pydantic 1/2 validation, JSON-compatible return normalization, and persistent asyncio loop.
- `src/utils/Logger.ts`: plain-text structured runtime logging.

Do not introduce a second declaration generator. Extend the inspector and codegen command together.
Do not spawn Python or pip directly from new Pynect code. Route it through `PyfigAdapter` so build and runtime ABI selection cannot diverge.
Do not add custom JavaScript locks or memo caches. Route keyed critical sections through `src/utils/Locking.ts` and use loqkit's `memoize` for memoized getters.
