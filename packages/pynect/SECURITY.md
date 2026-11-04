# Security

Pynect imports the configured ASGI app and runs it with the operating-system
permissions of the JavaScript process. Treat `pyproject.toml`, the app module,
its imports, and Pydantic validators as trusted executable code.

Local IPC is a transport convenience, not a sandbox. Unix sockets receive mode
`0600`; Windows uses the local named-pipe namespace. Put authentication and TLS
at the normal HTTP/WebSocket boundary for remote servers.

Pyfig owns uv and Python provisioning. Pynect injects its small schema/IPC
adapter into the selected uv environment and does not implement another package
resolver.

Report vulnerabilities privately to the repository owner before opening a
public issue. Include the affected commit, operating system, runtime versions,
and a minimal reproduction without secrets.
