# Security

Pynect imports the configured ASGI app and runs it with the operating-system
permissions of the JavaScript process. Treat `pyproject.toml`, the app module,
its imports, and Pydantic validators as trusted executable code.

The owned stdio worker is a transport convenience, not a sandbox. It is not
discoverable by another process, but the child has the same inherited operating
system authority and environment as any process the caller launches. Put
authentication and TLS at the normal HTTP/WebSocket boundary for remote
servers.

Pyfig owns uv and Python provisioning for schema generation. The stdio
transport instead requires an already resolved Python executable and does not
implement another package resolver.

Report vulnerabilities privately to the repository owner before opening a
public issue. Include the affected commit, operating system, runtime versions,
and a minimal reproduction without secrets.
