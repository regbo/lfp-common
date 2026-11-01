# Security

Pynect embeds Python in the JavaScript process. Treat every imported module and callable as trusted code with the permissions of that process.

## Safe defaults

- Raw Python code execution and native-addon access require `allowUnsafeCode: true`.
- Package installation requires `allowPackageInstall: true`.
- Tracebacks are hidden unless `includeTracebacks: true`.
- Dispatcher include, exclude, type-hint, and export policies are enforced inside the native call path.
- Dependency manifests cannot select indexes, credentials, interpreters, or installation policy.
- Postinstall synchronization runs only when lifecycle scripts are enabled (and, with Bun, Pynect is trusted); set `PYNECT_SKIP_POSTINSTALL=1` or disable lifecycle scripts to require explicit synchronization.
- Normal runtime startup validates the checked lock and environment fingerprint without installing packages.
- Local codegen discovery uses AST parsing and does not execute application modules.
- Private module and callable names are rejected; explicit excludes always win.
- Python package specifications and module identifiers are validated before subprocess use.
- Pyfig pins uv, downloads only Astral's GitHub release archive, and verifies its SHA-256 checksum before extraction.
- Pynect project sync and native builds use loqkit's layered memory, worker-thread, and cross-process file locks; process-owned runtime and garbage-collection sections use its memory lock.
- Pyfig and uv retain ownership of their package and managed-tool synchronization.
- uv owns Python dependency resolution and exact environment synchronization through the generated non-package `pyproject.toml`; Pynect does not implement a parallel resolver.

## Deployment guidance

Use a narrow dispatcher include list, run under a low-privilege operating-system account, and keep `allowUnsafeCode` and `allowPackageInstall` disabled for applications that process untrusted input. Do not let request data select module names, attribute paths, package specifications, Python code, or filesystem paths.

Pydantic validates data shapes; it is not a sandbox. Validators and serializers are Python code and must be trusted.

`callIsolated()` protects the Node.js process from a worker crash and allows hard termination on timeout. It does not reduce filesystem, network, environment, or operating-system permissions. Run hostile code in a separately secured account, container, virtual machine, or platform sandbox.

Codegen for explicitly requested installed modules uses runtime inspection and imports the package. Only inspect third-party packages you trust.

## Reporting

Report vulnerabilities privately to the repository owner before opening a public issue. Include the affected commit, platform, Python version, JavaScript runtime and version, and a minimal reproduction without secrets.
