# Security

Pyfig can download Astral uv release archives and can ask uv to download Python distributions. Automatic installation is enabled by default; set `autoInstall: false`, pass `--check`, or set `PYFIG_AUTO_INSTALL=0` when downloads are not allowed.

The uv release URL is pinned to an exact validated version and fetched over HTTPS with bounded redirects and timeouts. Pyfig verifies the adjacent SHA-256 checksum, validates the staged executable's reported version, and atomically publishes it into its cache. It never executes an installer script or modifies shell profiles or the host `PATH`. Proxy variables are honored through a per-request dispatcher without logging proxy credentials.

Provisioning uses in-process, worker, optional native advisory, and portable filesystem coordination followed by a post-lock capability check. Runtime dependency mutation uses uv's target-environment lock. Pyfig pins uv commands to the selected venv and removes configuration values that could redirect them. It reads an existing `pyproject.toml` only as a resolver input and never writes project manifests or requirements files.

Executable paths, project roots, version ranges, package specifications, indexes, and proxy settings remain trusted configuration. Do not let an untrusted user choose `python`, `PYFIG_UV`, `cacheDir`, package arguments, or related environment variables in a privileged process. A checksum fetched from the same release protects transfer integrity, not a compromised upstream publisher.
