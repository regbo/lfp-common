"""Hold application import until the owning test releases this worker PID."""

import os
import sys
import tempfile
import time
from importlib import import_module
from pathlib import Path

release = Path(tempfile.gettempdir()) / f"pynect-import-{os.getpid()}.continue"
sys.stderr.write(f"PYNECT_IMPORT_BARRIER={release}\n")
sys.stderr.flush()
deadline = time.monotonic() + 10
while not release.exists():
    if time.monotonic() >= deadline:
        raise TimeoutError(f"timed out waiting for {release}")
    time.sleep(0.01)
release.unlink(missing_ok=True)

app = import_module("pynect_example.server").app

__all__ = ["app"]
