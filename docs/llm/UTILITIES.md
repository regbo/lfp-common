# Utility catalog

- `scripts/process.ts`: shell-free child-process execution shared by release tooling.
- `ReadonlyGeneratedFiles`: Projen mixin that makes every synthesized file read-only across the project tree.
- `PackageMetadata`: emits tracked, read-only `_generated/metadata.ts` modules and merges public `./metadata` package exports.
- `WorkspacePackageInfo` and `workspacePackageTable`: derive root package documentation from the Projen subproject tree.
- `PackageVerification`: discovers every package-owned TypeScript config and generates its `typecheck` and `verify` tasks.
- `createJsPackage`: creates a publishable Bun/TypeScript package with shared compiler policy, metadata, scripts, and verification.
- `createPyPackage`: creates uv packages from native Projen project metadata.
- `configurePythonTests`: adds shared pytest and Ruff task coverage to a Python package.
- `pythonPackages`: discovers uv packages from the Projen subproject tree.
- `scripts/version.ts`: reads and validates the root `VERSION` source shared by every package.
- `scripts/workspaces.ts`: Pacwich-backed workspace discovery and shared-version validation.
- `scripts/release-lib.ts`: pure SemVer, tag, GitHub remote, and identity helpers.
- `scripts/release-git.ts`: guarded worktree preparation, snapshot, and restoration for releases.
- `scripts/release.ts`: local fixed-version release transaction.
- `scripts/release-check.ts`: tag-workflow and registry preflight.
- Bun runs each generated `pack:release` package script across the workspace.
- Pacwich runs each generated `publish:release` package script in workspace dependency order.
- `.github/workflows/publish.yml`: publishes npm and matrix-configured PyPI packages, then creates one GitHub Release after every publisher succeeds.

Project metadata, dependency versions, TypeScript configuration, tasks, and GitHub workflows belong in `.projenrc.ts`.