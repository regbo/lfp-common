import subprocess
import sys


def test_stdio_runtime_does_not_import_http_stack() -> None:
    script = """
import sys

import pynect.worker.stdio

http_roots = ("chanx.fast_channels", "fastapi", "httpx", "starlette", "uvicorn")
unexpected = sorted(
    name
    for name in sys.modules
    if any(name == root or name.startswith(f"{root}.") for root in http_roots)
)
if unexpected:
    raise SystemExit(f"stdio runtime imported HTTP modules: {unexpected}")
"""
    result = subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True,
        check=False,
        text=True,
    )

    assert result.returncode == 0, result.stderr
