# Utility catalog

| Utility | Location | Responsibility | Main consumers |
| --- | --- | --- | --- |
| `resolveOptions` | `src/config.ts` | Snapshot and validate centralized API and environment configuration. | Provisioning, runners, CLI |
| `resolveProjectRoot` | `src/project-root.ts` | Resolve workspace, package-manager, Python, or Git project ownership. | Configuration, public API |
| `withProvisioningLock` | `src/provision-lock.ts` | Bind Pyfig's idempotent provisioning checks to Loqkit's memory, worker, and file lock. | uv, Python, and venv provisioning |
| Loqkit `memoize` | `src/client.ts` | Share the first successful resolution within one immutable scoped client. | Long-lived library consumers |
| `resolveExecutable`, `run`, `runAsync` | `src/process.ts` | Resolve safe executables and run bounded argument-array child processes. | Probes, provisioning, coordination |
| Python and tool probes | `src/probes.ts` | Discover Python, pip, and uv and report interpreter/embedding ABI metadata. | Provisioning |
| Package target policy | `src/package-target.ts` | Reject target escapes and construct sanitized pip/uv environments. | Spawn runners |
| Venv path utilities | `src/virtual-environment.ts` | Canonicalize venv paths, locate its interpreter, and activate child environments. | Probes, provisioning, runners |
| `runtimeFile` | `src/runtime-files.ts` | Locate helper entry points without shared globals in ESM and CJS builds. | Synchronous runners |
| `createPyfig` | `src/client.ts` | Bind one options object to the consumer-facing preparation and spawn API. | Long-lived library consumers |
| Provisioning API | `src/provision.ts` | Reuse or safely install uv, Python, and the repository `.venv`. | Public API, CLI, sync bridge |
| Spawn API | `src/runners.ts` | Run Python, pip, and uv through the selected environment in async or sync form. | Public API, Pynect |
| `sync-resolver` | `src/sync-resolver.ts` | Perform async preparation behind synchronous caller APIs using `process.execPath`. | Synchronous runners |
| CLI | `src/cli.ts` | Expose validated preparation and check-only policy through Commander. | End users |
| CJS builder | `scripts/build-cjs.ts` | Bundle the public and sync-helper CommonJS entry points. | Package build |
| Script command runner | `scripts/command.ts` | Run shell-free child commands and relaunch the current Bun executable. | Prepack and local release scripts |
| Local release gate | `scripts/release.ts`, `scripts/release-utils.ts` | Derive the next remote SemVer, verify locally, audit, commit, tag, and atomically push. | Administrators running `bun run release` |
| Prepack gate | `scripts/prepack.ts` | Verify and build local packages while honoring the tag workflow's explicit global bypass. | Bun/npm package lifecycle |
| Release validation | `scripts/check-release.ts`, `scripts/audit-package.ts` | Match tags to versions, reject existing registry versions, and audit the exact npm archive. | Trusted npm publishing workflow |

Keep discovery side-effect free in `probes.ts`, mutations in `provision.ts`, and lock implementation details in Loqkit.
