# Security

Pynect embeds Python in the JavaScript process. Treat every imported module and callable as trusted code with the permissions of that process.

## Safe defaults

- Raw Python code execution and native-addon access require `allowUnsafeCode: true`.
- Package installation requires `allowPackageInstall: true`.
- Tracebacks are hidden unless `includeTracebacks: true`.
- Dispatcher include, exclude, annotation, and export policies are enforced inside the native call path.
- Local codegen discovery uses AST parsing and does not execute application modules.
- Private module and callable names are rejected; explicit excludes always win.
- Python package specifications and module identifiers are validated before subprocess use.
- Pyfig pins uv, downloads only Astral's GitHub release archive, and verifies its SHA-256 checksum before extraction.
- Pyfig protects managed-tool installation with `proper-lockfile` check-lock-check sections.

## Deployment guidance

Use a narrow dispatcher include list, run under a low-privilege operating-system account, and keep `allowUnsafeCode` and `allowPackageInstall` disabled for applications that process untrusted input. Do not let request data select module names, attribute paths, package specifications, Python code, or filesystem paths.

Pydantic validates data shapes; it is not a sandbox. Validators and serializers are Python code and must be trusted.

`callIsolated()` protects the Node.js process from a worker crash and allows hard termination on timeout. It does not reduce filesystem, network, environment, or operating-system permissions. Run hostile code in a separately secured account, container, virtual machine, or platform sandbox.

Codegen for explicitly requested installed modules uses runtime inspection and imports the package. Only inspect third-party packages you trust.

## Reporting

Report vulnerabilities privately to the repository owner before opening a public issue. Include the affected commit, platform, Python version, JavaScript runtime and version, and a minimal reproduction without secrets.
