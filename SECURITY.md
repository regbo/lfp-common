# Security

Pyfig invokes uv and Python only to resolve, provision, and validate the
requested context. Setup downloads an official Astral release archive and
adjacent SHA-256 checksum over HTTPS, verifies the archive before publication,
and probes the staged executable. It never runs an installer script or modifies
shell and project configuration.

Compatible cached uv executables are used without network access. GitHub release
metadata is cached for 24 hours, with valid stale metadata retained as a network
fallback. Cache publication and metadata refresh use Loqkit's in-memory,
worker, native-flock-when-available, and portable file-lock coordination.

The executable path, working directory, environment, and version requests are
trusted caller input. uv owns Python discovery and managed-Python downloads.
Supply an explicit uv executable or pre-populate the cache when setup downloads
are prohibited, and configure uv itself when Python downloads must be offline
or restricted by organizational policy.
