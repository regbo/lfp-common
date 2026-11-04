"""Small Python adapters used by the Pynect TypeScript package."""

from pynect_worker._generated.metadata import PACKAGE_NAME, PACKAGE_VERSION
from pynect_worker.handlers import ws_handler

__all__ = ["PACKAGE_NAME", "PACKAGE_VERSION", "ws_handler"]
