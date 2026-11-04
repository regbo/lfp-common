from __future__ import annotations

import subprocess
import sys

from pynect_worker import PACKAGE_VERSION


def run_cli(*arguments: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "pynect_worker", *arguments],
        check=False,
        capture_output=True,
        text=True,
    )


def test_worker_cli_reports_the_shared_version() -> None:
    result = run_cli("--version")

    assert result.returncode == 0
    assert PACKAGE_VERSION in result.stdout


def test_server_help_comes_from_the_pydantic_options() -> None:
    result = run_cli("serve", "--help")

    assert result.returncode == 0
    assert "--validate-pydantic" in result.stdout
    assert "--max-frame-bytes" in result.stdout
    assert "--modules" in result.stdout
