# Utility catalog

| Utility | Location | Responsibility | Main consumers |
| --- | --- | --- | --- |
| `resolveOptions` | `src/config.ts` | Snapshot and validate centralized API and environment configuration. | Provisioning, runners, CLI |
| `resolveProjectRoot` | `src/project-root.ts` | Resolve explicit/current Git ownership without interpreting manifests. | Configuration, public API |
| `withProvisioningLock` | `src/provision-lock.ts` | Bind Pyfig's idempotent provisioning checks to Loqkit's memory, worker, and file lock. | uv, Python, and venv provisioning |
| Loqkit `memoize` | `src/client.ts` | Share the first successful preparation within one configured `pyenv`. | Long-lived library consumers |
| Venv identity | `src/venv-identity.ts` | Hash the exact interpreter and dependency resolution, validate the venv marker, and publish metadata last. | Venv provisioning |
| `resolveExecutable`, `run`, `runAsync` | `src/process.ts` | Resolve safe executables and run bounded argument-array child processes. | Probes, provisioning, coordination |
| Python and tool probes | `src/probes.ts` | Probe Python capabilities, version-specific and Stable ABI embedding libraries, and compatible uv executables. | Provisioning |
| PEP 440 version policy | `src/pep440.ts` | Validate and evaluate `requiresPython` and `requiresUv` specifiers consistently. | Configuration, probes |
| uv target policy | `src/package-target.ts` | Pin `uv pip` and `uv run` to the selected environment. | Spawn runners |
| Python venv utilities | `src/python-venv.ts` | Canonicalize Python venv paths, locate their interpreters, and activate child processes. | Probes, provisioning, runners |
| `runtimeFile` | `src/runtime-files.ts` | Locate helper entry points without shared globals in ESM and CJS builds. | Synchronous runners |
| `Python` | `src/client.ts` | Bind one venv configuration to the consumer-facing preparation and spawn API. | Long-lived library consumers |
| Provisioning API | `src/provision.ts` | Prefer system Python, pass explicit runtime inputs to uv, reuse dependency-free external venvs, and provision isolated venvs identified by uv's compiled output. | Public API, CLI, sync bridge |
| Spawn API | `src/runners.ts` | Run uv and bind its pip/run commands to the selected environment. | Public API, Pynect |
| `sync-resolver` | `src/sync-resolver.ts` | Perform async preparation behind synchronous caller APIs using `process.execPath`. | Synchronous runners |
| CLI | `src/cli.ts` | Expose validated preparation and check-only policy through Commander. | End users |
| CJS builder | `scripts/build-cjs.ts` | Bundle the public and sync-helper CommonJS entry points. | Package build |
| Script command runner | `scripts/command.ts` | Run shell-free child commands and relaunch the current Bun executable. | Prepack and local release scripts |
| Local release gate | `scripts/release.ts`, `scripts/release-utils.ts` | Derive the next remote SemVer, verify locally, audit, commit, tag, and atomically push. | Administrators running `bun run release` |
| Prepack gate | `scripts/prepack.ts` | Verify and build local packages while honoring the tag workflow's explicit global bypass. | Bun/npm package lifecycle |
| Release validation | `scripts/check-release.ts`, `scripts/audit-package.ts` | Match tags to versions, reject existing registry versions, and audit the exact npm archive. | Trusted npm publishing workflow |

Keep discovery side-effect free in `probes.ts`, mutations in `provision.ts`, and lock implementation details in Loqkit.
