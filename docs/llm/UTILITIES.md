# Utility catalog

- `scripts/process.ts`: shell-free child-process execution shared by release tooling.
- `ReadonlyGeneratedFiles`: Projen mixin that makes every synthesized file read-only across the project tree.
- `scripts/workspaces.ts`: Pacwich-backed workspace discovery and shared-version validation.
- `scripts/release-lib.ts`: pure SemVer, tag, GitHub remote, and identity helpers.
- `scripts/release.ts`: local fixed-version release transaction.
- `scripts/release-check.ts`: tag-workflow and registry preflight.
- Bun runs each generated `pack:release` package script across the workspace.
- Pacwich runs each generated `publish:release` package script in workspace dependency order.

Project metadata, dependency versions, TypeScript configuration, tasks, and GitHub workflows belong in `.projenrc.ts`.