# Security

Pynect imports and executes Python packages with the operating-system permissions of the JavaScript process. Treat project metadata, dependency specifications, imported modules, callbacks, and Pydantic validators as executable trusted code.

## Boundaries

- Each Venv runs in a separate Python process, but it is not an operating-system sandbox.
- Module names, attribute paths, projects, requirements, and additional uv arguments must not come directly from untrusted request data.
- `validatePydantic` validates data shapes. Pydantic validators and serializers can execute arbitrary Python code.
- JavaScript callbacks execute in the host process and can call Python again.
- Python code generation imports the selected modules for inspection and can run their import-time code.
- Unix sockets are created with user-only filesystem permissions. Windows named pipes use the local pipe namespace. Every worker connection must also complete a random-token handshake.
- RPC frames have a fixed maximum size, but application calls can still allocate substantial memory or CPU in either process.
- Pyfig owns uv and Python provisioning. Pynect does not download executables or implement a second package resolver.

Run untrusted Python under a restricted account, container, virtual machine, or another appropriate sandbox. Process separation protects the JavaScript heap from ordinary Python exceptions and many crashes; it does not restrict filesystem, network, child-process, device, or credential access.

## Reporting

Report vulnerabilities privately to the repository owner before opening a public issue. Include the affected commit, operating system, JavaScript runtime, Python version, and a minimal reproduction without secrets.
