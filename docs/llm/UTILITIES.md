# Utility catalog

- `scripts/process.ts`: shell-free child-process execution shared by release tooling.
- `scripts/workspaces.ts`: canonical package order, locations, and manifest validation.
- `scripts/archive.ts`: npm archive content, metadata, workspace-protocol, email, and secret audit.
- `scripts/pack-packages.ts`: packs every workspace in dependency order and audits the exact tarballs.
- `scripts/release-lib.ts`: pure SemVer, tag, GitHub remote, and identity helpers.
- `scripts/release.ts`: local fixed-version release transaction.
- `scripts/release-check.ts`: tag-workflow and registry preflight.
- `scripts/prepack.ts`: fail-closed package lifecycle gate.
- `scripts/publish-packages.ts`: publishes only the audited tarballs created by the pack step.

Project metadata, dependency versions, TypeScript configuration, tasks, and GitHub workflows belong in `.projenrc.ts`.