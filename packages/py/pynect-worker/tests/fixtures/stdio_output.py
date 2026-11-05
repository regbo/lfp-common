import sys

sys.stdout.buffer.write(b"partial-without-newline\x00")
sys.stdout.buffer.flush()
sys.stderr.write("stdio fixture stderr\n")
sys.stderr.flush()

from tests.fixtures.catalog import app  # noqa: E402

__all__ = ["app"]
