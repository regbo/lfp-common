# Security

Pyfig spawns only the uv executable resolved from `uv`, found on `PATH`, or
installed in its OS cache. Setup downloads an official Astral release archive
and adjacent SHA-256 checksum over HTTPS, verifies the archive before
publication, and probes the staged executable. It never runs an installer
script, invokes a shell by default, or modifies shell and project configuration.

Compatible cached uv executables are used without network access. GitHub release
metadata is cached for 24 hours, with valid stale metadata retained as a network
fallback. Cache publication and metadata refresh use Loqkit's in-memory,
worker, native-flock-when-available, and portable file-lock coordination.

The executable path, working directory, environment, version requests, uv
arguments, command arguments, and spawn options are trusted caller input. The
`run()` method can execute arbitrary commands, and callers can explicitly
enable shell execution through `SpawnOptions`. uv owns Python discovery and
managed-Python downloads. Supply an explicit uv executable or pre-populate the
cache when setup downloads are prohibited, and configure uv itself when Python
downloads must be offline or restricted by organizational policy.
