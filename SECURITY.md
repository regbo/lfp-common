# Security

Pyfig invokes uv to resolve and provision the requested context. Both public
spawn helpers execute uv with caller-provided arguments; Python commands run
through `uv run` with a privately selected interpreter. UV therefore retains
its documented project locking, lockfile, synchronization, and environment
behavior.

UV setup selects versions from Astral's official release manifest, downloads
the platform artifact from Astral's release mirror or canonical GitHub over
HTTPS, and verifies the manifest's SHA-256 checksum before extraction. The
staged executable is probed before publication. Shell profiles and the caller's
`PATH` are never modified. Compatible cached UV executables are used without
network access. Release metadata is cached for 24 hours, with valid stale
metadata retained as a network fallback. Cache publication and metadata refresh use Loqkit's
in-memory, worker, native-flock-when-available, and portable file-lock
coordination.

Configured Astral or installer mirror URLs are exclusive: Pyfig does not fall
back to public hosts when a custom source applies. Python interpreter paths are
not part of the public context and are redacted from Pyfig-generated resolution
errors and diagnostics.

The UV request, Python request, working directory, and environment are trusted
caller input. Python discovery and downloads follow UV's own configuration and
policy. Pyfig retries UV versions before 0.11 through Astral only when UV's
default attempt failed at the canonical GitHub Python release URL and no custom
Python source environment variable is present. Supply an explicit UV
executable or pre-populate Pyfig's cache when UV setup downloads are
prohibited. Configure UV with `UV_PYTHON_DOWNLOADS`, `UV_OFFLINE`, or its
documented settings when Python downloads must be restricted.
